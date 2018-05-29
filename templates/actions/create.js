/**
 * create
 *
 * returns a function with access to an interruption context
 *
 * @description :: Server-side logic for a generic crud controller create action that can be used to represent all models
 * @help        :: See http://sailsjs.org/#!/documentation/concepts/Controllers
 */
const actionUtil = require('./../util/actionUtil');
const shimFunction = require('./../util/shimFunction');
const defaultInterrupt = require('./../interrupts/defaultInterrupt');
const { parallel, waterfall } = require('async');

module.exports = function(interrupts = {}) {
    interrupts = shimFunction(interrupts, 'create');
    interrupts.create = interrupts.create ? interrupts.create : defaultInterrupt;

    return function(req, res) {
        const Model = actionUtil.parseModel(req);
        const data = actionUtil.parseValues(req, Model);
        const associations = actionUtil.getAssociationConfiguration(Model, 'detail');
        const preppedRelations = actionUtil.prepareManyRelations(associations, data);

        waterfall(
            [
                done => {
                    Model.create(data).meta({fetch: true}).exec((err, newInstance) => {
                        if (err) {
                            return done(err);
                        }
                        done(null, newInstance);
                    });
                },
                (newInstance, done) => {
                    const pk = newInstance[Model.primaryKey];
                    const saveMany = [];
                    preppedRelations.forEach(rel => {
                        saveMany.push(done => {
                            Model.replaceCollection(pk, rel.collection)
                                .members(rel.values)
                                .exec(done);
                        });
                    });
                    parallel(saveMany, () => {
                        done(null, newInstance);
                    });
                },
                (newInstance, done) => {
                    interrupts.create.call(
                        this,
                        req,
                        res,
                        () => {
                            done(null, newInstance);
                        },
                        Model,
                        newInstance
                    );
                },
                (newInstance, done) => {
                    // Do a final query to populate the associations of the record.
                    const query = Model.findOne(newInstance[Model.primaryKey]);
                    parallel(
                        {
                            populatedRecord: done => {
                                actionUtil.populateRecords(query, associations).exec(done);
                            },
                            associated: done => {
                                actionUtil.populateIndexes(Model, newInstance[Model.primaryKey], associations, done);
                            }
                        },
                        (err, results) => {
                            if (err) {
                                return done(err);
                            }
                            const { associated, populatedRecord } = results;
                            if (!populatedRecord) {
                                return done(new Error('Could not find record after updating!'));
                            }
                            return done(null, {
                                associated,
                                newInstance,
                                populatedRecord
                            });
                        }
                    );
                },
                ({ associated, newInstance, populatedRecord }, done) => {
                    return done(null, {
                        emberizedJSON: Ember.buildResponse(Model, populatedRecord, associations, associated),
                        newInstance
                    });
                }
            ],
            (err, results) => {
                if (err) {
                    return actionUtil.negotiate(res, err, actionUtil.parseLocals(req));
                }
                const { emberizedJSON, newInstance } = results;
                if (req._sails.hooks.pubsub) {
                    if (req.isSocket) {
                        Model.subscribe(req, [newInstance[Model.primaryKey]]);
                        Model._introduce(newInstance);
                    }
                    Model._publishCreate(newInstance, !req.options.mirror && req);
                }
                res.created(emberizedJSON, actionUtil.parseLocals(req));
            }
        );
    };
};
