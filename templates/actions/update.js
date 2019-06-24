/**
 * update
 *
 * returns a function with access to an interruption context
 *
 * @description :: Server-side logic for a generic crud controller update action that can be used to represent all models
 * @help        :: See http://sailsjs.org/#!/documentation/concepts/Controllers
 */
const actionUtil = require('./../util/actionUtil');
const shimFunction = require('./../util/shimFunction');
const defaultInterrupt = require('./../interrupts/defaultInterrupt');
const { parallel, waterfall } = require('async');
const { cloneDeep } = require('lodash');

module.exports = function(interrupts = {}, afterUpdate) {
    const shimmedAfterUpdate = shimFunction(afterUpdate, 'afterUpdate');
    interrupts = shimFunction(interrupts, 'beforeUpdate');
    if (shimmedAfterUpdate) {
        Object.assign(interrupts, shimmedAfterUpdate);
    }
    interrupts.beforeUpdate = interrupts.beforeUpdate ? interrupts.beforeUpdate : defaultInterrupt;
    interrupts.afterUpdate = interrupts.afterUpdate ? interrupts.afterUpdate : defaultInterrupt;

    return function(req, res) {
        // Look up the model
        const Model = actionUtil.parseModel(req);
        const { log } = req._sails;
        const toJSON = Model.customToJSON
            ? Model.customToJSON
            : function() {
                  return this;
              };
        // Locate and validate the required `id` parameter.
        const pk = actionUtil.requirePk(req);
        // Create `values` object (monolithic combination of all parameters)
        // But omit the blacklisted params (like JSONP callback param, etc.)
        const data = actionUtil.parseValues(req, Model);
        // Look up the association configuration and determine how to populate the query
        // @todo support request driven selection of includes/populate
        const associations = actionUtil.getAssociationConfiguration(Model, 'detail');
        const preppedRelations = actionUtil.prepareManyRelations(associations, data);

        waterfall(
            [
                done => {
                    Model.findOne(pk).exec((err, matchingRecord) => {
                        if (err) {
                            return done(err);
                        }
                        if (!matchingRecord) {
                            return done(404);
                        }
                        done(null, matchingRecord);
                    });
                },
                (matchingRecord, done) => {
                    //also, we gain context on what the record looks like before it is updated,
                    //which will be used in the afterUpdate interrupt
                    interrupts.beforeUpdate.call(
                        this,
                        req,
                        res,
                        () => {
                            done(null, matchingRecord);
                        },
                        Model,
                        data
                    );
                },
                (matchingRecord, done) => {
                    Model.update(pk, data).meta({fetch: true}).exec((err, records) => {
                        if (err) {
                            return done(err);
                        }
                        if (!Array.isArray(records)) {
                            return done(new Error(`${Model.globalId}.update returned no records!`));
                        }
                        // Because this should only update a single record and update
                        // returns an array, just use the first item.  If more than one
                        // record was returned, something is amiss.
                        if (records.length > 1) {
                            log.warn(`Unexpected output from ${Model.globalId}.update.`);
                        }
                        const updatedRecord = records[0];
                        done(null, { matchingRecord, updatedRecord });
                    });
                },
                ({ matchingRecord, updatedRecord }, done) => {
                    const saveMany = [];
                    preppedRelations.forEach(rel => {
                        saveMany.push(done => {
                            Model.replaceCollection(pk, rel.collection)
                                .members(rel.values)
                                .exec(done);
                        });
                    });
                    parallel(saveMany, () => {
                        done(null, { matchingRecord, updatedRecord });
                    });
                },
                ({ matchingRecord, updatedRecord }, done) => {
                    interrupts.afterUpdate.call(
                        this,
                        req,
                        res,
                        () => {
                            done(null, { matchingRecord, updatedRecord });
                        },
                        Model,
                        { before: matchingRecord, after: updatedRecord }
                    );
                },
                ({ matchingRecord, updatedRecord }, done) => {
                    const query = Model.findOne(updatedRecord[Model.primaryKey]);
                    parallel(
                        {
                            populatedRecord: done => {
                                actionUtil.populateRecords(query, associations).exec(done);
                            },
                            associated: done => {
                                actionUtil.populateIndexes(Model, pk, associations, done);
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
                            done(null, { associated, matchingRecord, populatedRecord });
                        }
                    );
                },
                ({ associated, matchingRecord, populatedRecord }, done) => {
                    const emberizedJSON = Ember.buildResponse(Model, populatedRecord, associations, associated);
                    return done(null, { emberizedJSON, matchingRecord });
                }
            ],
            (err, results) => {
                if (err) {
                    if (err === 404) {
                        return res.notFound();
                    }
                    return actionUtil.negotiate(res, err, actionUtil.parseLocals(req));
                }
                const { emberizedJSON, matchingRecord } = results;
                if (req._sails.hooks.pubsub) {
                    if (req.isSocket) {
                        Model.subscribe(req, [matchingRecord[Model.primaryKey]]);
                    }
                    Model._publishUpdate(pk, cloneDeep(data), !req.options.mirror && req, {
                        previous: toJSON.call(matchingRecord)
                    });
                }
                res.ok(emberizedJSON, actionUtil.parseLocals(req));
            }
        );
    };
};
