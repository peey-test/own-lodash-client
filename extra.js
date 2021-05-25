// from https://github.com/entrinsik-org/hapi-sequelize/blob/master/lib/history-plugin.js
'use strict';

var _ = require('lodash');
var joi = require('joi');
var util = require('util');
var internals = {};

internals.user = function () {

};

/**
 * Creates a joi schema for validating history options against a sequelize model
 * @param model
 * @return {{track: *, idAttr: *, modelName: *, tableName: *, user: *}}
 */
internals.optionsSchema = function (model) {
    return {
        // fields to track - defaults to all fields
        track: joi.array().items(joi.string()).single().default(Object.keys(model.attributes)),

        // the id attribute of the source model
        idAttr: joi.string().default('id'),

        // the history model name (e.g. "OrderHistory")
        modelName: joi.string().default(model.name + 'History'),

        // the history table name (e.g. "order_history")
        tableName: joi.string().default(model.tableName + '_history'),
    };
};

/**
 * builds the sequelize model definition
 * @param model the sequelize model to track
 * @param {{}} options history options
 * @return {Model} the history model
 */
internals.createHistoryModel = function (model, options) {
    var sequelize = model.sequelize;
    var DataTypes = sequelize.Sequelize;

    var idAttr = model.attributes[options.idAttr];

    if (!idAttr) throw new Error('Invalid id attribute for model ' + model.name + ': ' + options.idAttr);

    // attributes about the change, prefixed with _ to limit conflicts
    var metaAttrs = {
        // a rolling unique id because sequelize really wants an id
        _id: { type: DataTypes.INTEGER, primaryKey: true, autoIncrement: true },

        // the id of the tracked table
        _sourceId: { type: idAttr.type, allowNull: false, unique: 'naturalId' },

        // a rolling revision number per tracked id
        _revision: { type: DataTypes.INTEGER, unique: 'naturalId' },

        // a spot for a username or id. clients must use a pre-create hook to set this attribute
        _user: DataTypes.STRING,

        // timestamp of the change
        _date: DataTypes.DATE,

        // the fields that were changed to trigger the history log
        _changes: DataTypes.ARRAY(DataTypes.STRING)
    };

    // the fields to track
    var attrs = _(model.attributes)
        .pick(options.track)
        .mapValues(attr => _.omit(attr, 'autoIncrement'))
        .merge(metaAttrs)
        .value();

    var instanceMethods = {
        /**
         * restores the tracked item to the current revision
         * @return {*}
         */
        restore: function () {
            var values = _.pick(this, options.track);

            return this.getSource()
                .then(function (source) {
                    return source.update(values);
                });
        }
    };

    var classMethods = {
        sync: function () {
            var tableName = this.tableName;

            function dropInsertTrigger() {
                return sequelize.query(util.format('DROP TRIGGER IF EXISTS insert_%s ON %s', tableName, tableName));
            }

            function createInsertFn() {
                return sequelize.query(util.format('CREATE OR REPLACE FUNCTION insert_%s() RETURNS TRIGGER AS $$ BEGIN NEW._revision := (SELECT coalesce(max(_revision), 0) FROM %s WHERE "_sourceId" = NEW."_sourceId") + 1; RETURN NEW; END; $$ language plpgsql;', tableName, tableName));
            }

            function createInsertTrigger() {
                return sequelize.query(util.format('CREATE TRIGGER insert_%s BEFORE INSERT ON %s FOR EACH ROW EXECUTE PROCEDURE insert_%s()', tableName, tableName, tableName));
            }

            return sequelize.Model.prototype.sync.apply(this, arguments)
                .then(createInsertFn)
                .then(dropInsertTrigger)
                .then(createInsertTrigger)
        }
    };

    // sequelize model options
    var modelOpts = {
        tableName: options.tableName,
        instanceMethods: instanceMethods,
        classMethods: classMethods,
        timestamps: false,
        indexes: [{ fields: ['_sourceId'] }]
    };

    return model.sequelize.define(options.modelName, attrs, modelOpts);
};

/**
 * Associates the history model to the source model
 * @param historyModel
 * @param sourceModel
 * @return {*}
 */
internals.associate = function (historyModel, sourceModel) {
    historyModel.belongsTo(sourceModel, { as: 'source', foreignKey: '_sourceId', onDelete: 'cascade' });
    return historyModel;
};

/**
 * Writes a history entry
 * @param historyModel the history sequelize model
 * @param sourceModel the source sequelize model
 * @param options model options
 * @param instance the sourceModel instance
 * @return {*}
 */
internals.writeHistory = function (historyModel, sourceModel, options, instance) {
    var record = _(instance._previousDataValues)
        .pick(options.track)
        .merge({
            _sourceId: instance[options.idAttr],
            _date: new Date(),
            _changes: instance.changed()
        })
        .value();

    return historyModel.create(record);
};

/**
 * Registers hooks for tracking changes
 * @param historyModel the history sequelize model
 * @param sourceModel the source sequelize model
 * @param options history options
 * @return {*}
 */
internals.addHooks = function (historyModel, sourceModel, options) {
    sourceModel.afterUpdate(function (instance) {
        if (_.intersection(instance.changed(), options.track).length > 0)
            return internals.writeHistory(historyModel, sourceModel, options, instance)
    });

    return historyModel;
};

/**
 * the model plugin function
 * @param options
 * @return {Function}
 */
module.exports = function (options) {
    if (_.isArray(options)) options = { track: options };

    options = _.isPlainObject(options) ? options : { track: [].slice.call(arguments) };

    return function (model) {
        joi.validate(options, internals.optionsSchema(model), function (err, validated) {
            if (err) throw err;
            options = validated;
        });

        return internals.addHooks(internals.associate(internals.createHistoryModel(model, options), model), model, options);
    };
};
