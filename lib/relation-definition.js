// Copyright IBM Corp. 2014,2019. All Rights Reserved.
// Node module: loopback-datasource-juggler
// This file is licensed under the MIT License.
// License text available at https://opensource.org/licenses/MIT

'use strict';

/*!
 * Dependencies
 */
const assert = require('assert');
const util = require('util');
const async = require('async');
const utils = require('./utils');
const i8n = require('inflection');
const defineScope = require('./scope.js').defineScope;
const g = {
  f: (val, ...rest) => {
    return val;
  },
};
const mergeQuery = utils.mergeQuery;
const idEquals = utils.idEquals;
const idsHaveDuplicates = utils.idsHaveDuplicates;
const ModelBaseClass = require('./model.js');
const applyFilter = require('./connectors/memory').applyFilter;
const ValidationError = require('./validations.js').ValidationError;
const deprecated = require('depd')('loopback-datasource-juggler');
const debug = require('debug')('loopback:relations');

const RelationTypes = {
  belongsTo: 'belongsTo',
  hasMany: 'hasMany',
  hasOne: 'hasOne',
  hasAndBelongsToMany: 'hasAndBelongsToMany',
  referencesMany: 'referencesMany',
  embedsOne: 'embedsOne',
  embedsMany: 'embedsMany',
};

const RelationClasses = {
  belongsTo: BelongsTo,
  hasMany: HasMany,
  hasManyThrough: HasManyThrough,
  hasOne: HasOne,
  hasAndBelongsToMany: HasAndBelongsToMany,
  referencesMany: ReferencesMany,
  embedsOne: EmbedsOne,
  embedsMany: EmbedsMany,
};

exports.Relation = Relation;
exports.RelationDefinition = RelationDefinition;

exports.RelationTypes = RelationTypes;
exports.RelationClasses = RelationClasses;

exports.HasMany = HasMany;
exports.HasManyThrough = HasManyThrough;
exports.HasOne = HasOne;
exports.HasAndBelongsToMany = HasAndBelongsToMany;
exports.BelongsTo = BelongsTo;
exports.ReferencesMany = ReferencesMany;
exports.EmbedsOne = EmbedsOne;
exports.EmbedsMany = EmbedsMany;

function normalizeType(type) {
  if (!type) {
    return type;
  }
  const t1 = type.toLowerCase();
  for (const t2 in RelationTypes) {
    if (t2.toLowerCase() === t1) {
      return t2;
    }
  }
  return null;
}

function extendScopeMethods(definition, scopeMethods, ext) {
  let customMethods = [];
  let relationClass = RelationClasses[definition.type];
  if (definition.type === RelationTypes.hasMany && definition.modelThrough) {
    relationClass = RelationClasses.hasManyThrough;
  }
  if (typeof ext === 'function') {
    customMethods = ext.call(definition, scopeMethods, relationClass);
  } else if (typeof ext === 'object') {
    function createFunc(definition, relationMethod) {
      return function() {
        const relation = new relationClass(definition, this);
        return relationMethod.apply(relation, arguments);
      };
    }
    for (const key in ext) {
      const relationMethod = ext[key];
      const method = scopeMethods[key] = createFunc(definition, relationMethod);
      if (relationMethod.shared) {
        sharedMethod(definition, key, method, relationMethod);
      }
      customMethods.push(key);
    }
  }
  return [].concat(customMethods || []);
}

function bindRelationMethods(relation, relationMethod, definition) {
  const methods = definition.methods || {};
  Object.keys(methods).forEach(function(m) {
    if (typeof methods[m] !== 'function') return;
    relationMethod[m] = methods[m].bind(relation);
  });
}

function preventFkOverride(inst, data, fkProp) {
  if (!fkProp) return undefined;
  if (data[fkProp] !== undefined && !idEquals(data[fkProp], inst[fkProp])) {
    return new Error(g.f(
      'Cannot override foreign key %s from %s to %s',
      fkProp,
      inst[fkProp],
      data[fkProp],
    ));
  }
}

/**
 * Relation definition class.  Use to define relationships between models.
 * @param {Object} definition
 * @class RelationDefinition
 */
function RelationDefinition(definition) {
  if (!(this instanceof RelationDefinition)) {
    return new RelationDefinition(definition);
  }
  definition = definition || {};
  this.name = definition.name;
  assert(this.name, 'Relation name is missing');
  this.type = normalizeType(definition.type);
  assert(this.type, 'Invalid relation type: ' + definition.type);
  this.modelFrom = definition.modelFrom;
  assert(this.modelFrom, 'Source model is required');
  this.keyFrom = definition.keyFrom;
  this.modelTo = definition.modelTo;
  this.keyTo = definition.keyTo;
  this.polymorphic = definition.polymorphic;
  if (typeof this.polymorphic !== 'object') {
    assert(this.modelTo, 'Target model is required');
  }
  this.modelThrough = definition.modelThrough;
  this.keyThrough = definition.keyThrough;
  this.multiple = definition.multiple;
  this.properties = definition.properties || {};
  this.options = definition.options || {};
  this.scope = definition.scope;
  this.embed = definition.embed === true;
  this.methods = definition.methods || {};
}

RelationDefinition.prototype.toJSON = function() {
  const polymorphic = typeof this.polymorphic === 'object';

  let modelToName = this.modelTo && this.modelTo.modelName;
  if (!modelToName && polymorphic && this.type === 'belongsTo') {
    modelToName = '<polymorphic>';
  }

  const json = {
    name: this.name,
    type: this.type,
    modelFrom: this.modelFrom.modelName,
    keyFrom: this.keyFrom,
    modelTo: modelToName,
    keyTo: this.keyTo,
    multiple: this.multiple,
  };
  if (this.modelThrough) {
    json.modelThrough = this.modelThrough.modelName;
    json.keyThrough = this.keyThrough;
  }
  if (polymorphic) {
    json.polymorphic = this.polymorphic;
  }
  return json;
};

/**
 * Define a relation scope method
 * @param {String} name of the method
 * @param {Function} function to define
 */
RelationDefinition.prototype.defineMethod = function(name, fn) {
  const relationClass = RelationClasses[this.type];
  const relationName = this.name;
  const modelFrom = this.modelFrom;
  const definition = this;
  let method;
  if (definition.multiple) {
    const scope = this.modelFrom.scopes[this.name];
    if (!scope) throw new Error(g.f('Unknown relation {{scope}}: %s', this.name));
    method = scope.defineMethod(name, function() {
      const relation = new relationClass(definition, this);
      return fn.apply(relation, arguments);
    });
  } else {
    definition.methods[name] = fn;
    method = function() {
      const rel = this[relationName];
      return rel[name].apply(rel, arguments);
    };
  }
  if (method && fn.shared) {
    sharedMethod(definition, name, method, fn);
    modelFrom.prototype['__' + name + '__' + relationName] = method;
  }
  return method;
};

/**
 * Apply the configured scope to the filter/query object.
 * @param {Object} modelInstance
 * @param {Object} filter (where, order, limit, fields, ...)
 */
RelationDefinition.prototype.applyScope = function(modelInstance, filter) {
  filter = filter || {};
  filter.where = filter.where || {};
  if ((this.type !== 'belongsTo' || this.type === 'hasOne') &&
      typeof this.polymorphic === 'object') { // polymorphic
    const discriminator = this.polymorphic.discriminator;
    if (this.polymorphic.invert) {
      filter.where[discriminator] = this.modelTo.modelName;
    } else {
      filter.where[discriminator] = this.modelFrom.modelName;
    }
  }
  let scope;
  if (typeof this.scope === 'function') {
    scope = this.scope.call(this, modelInstance, filter);
  } else {
    scope = this.scope;
  }
  if (typeof scope === 'object') {
    mergeQuery(filter, scope);
  }
};

/**
 * Apply the configured properties to the target object.
 * @param {Object} modelInstance
 * @param {Object} target
 */
RelationDefinition.prototype.applyProperties = function(modelInstance, obj) {
  let source = modelInstance, target = obj;
  if (this.options.invertProperties) {
    source = obj;
    target = modelInstance;
  }
  if (this.options.embedsProperties) {
    target = target.__data[this.name] = {};
    target[this.keyTo] = source[this.keyTo];
  }
  let k, key;
  if (typeof this.properties === 'function') {
    const data = this.properties.call(this, source, target);
    for (k in data) {
      target[k] = data[k];
    }
  } else if (Array.isArray(this.properties)) {
    for (k = 0; k < this.properties.length; k++) {
      key = this.properties[k];
      target[key] = source[key];
    }
  } else if (typeof this.properties === 'object') {
    for (k in this.properties) {
      key = this.properties[k];
      target[key] = source[k];
    }
  }
  if ((this.type !== 'belongsTo' || this.type === 'hasOne') &&
      typeof this.polymorphic === 'object') { // polymorphic
    const discriminator = this.polymorphic.discriminator;
    if (this.polymorphic.invert) {
      target[discriminator] = this.modelTo.modelName;
    } else {
      target[discriminator] = this.modelFrom.modelName;
    }
  }
};

/**
 * A relation attaching to a given model instance
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {Relation}
 * @constructor
 * @class Relation
 */
function Relation(definition, modelInstance) {
  if (!(this instanceof Relation)) {
    return new Relation(definition, modelInstance);
  }
  if (!(definition instanceof RelationDefinition)) {
    definition = new RelationDefinition(definition);
  }
  this.definition = definition;
  this.modelInstance = modelInstance;
}

Relation.prototype.resetCache = function(cache) {
  cache = cache || undefined;
  this.modelInstance.__cachedRelations[this.definition.name] = cache;
};

Relation.prototype.getCache = function() {
  return this.modelInstance.__cachedRelations[this.definition.name];
};

Relation.prototype.callScopeMethod = function(methodName) {
  const args = Array.prototype.slice.call(arguments, 1);
  const modelInstance = this.modelInstance;
  const rel = modelInstance[this.definition.name];
  if (rel && typeof rel[methodName] === 'function') {
    return rel[methodName].apply(rel, args);
  } else {
    throw new Error(g.f('Unknown scope method: %s', methodName));
  }
};

/**
 * Fetch the related model(s) - this is a helper method to unify access.
 * @param (Boolean|Object} condOrRefresh refresh or conditions object
 * @param {Object} [options] Options
 * @param {Function} cb callback
 */
Relation.prototype.fetch = function(condOrRefresh, options, cb) {
  this.modelInstance[this.definition.name].apply(this.modelInstance, arguments);
};

/**
 * HasMany subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {HasMany}
 * @constructor
 * @class HasMany
 */
function HasMany(definition, modelInstance) {
  if (!(this instanceof HasMany)) {
    return new HasMany(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.hasMany);
  Relation.apply(this, arguments);
}

util.inherits(HasMany, Relation);

HasMany.prototype.removeFromCache = function(id) {
  const cache = this.modelInstance.__cachedRelations[this.definition.name];
  const idName = this.definition.modelTo.definition.idName();
  if (Array.isArray(cache)) {
    for (let i = 0, n = cache.length; i < n; i++) {
      if (idEquals(cache[i][idName], id)) {
        return cache.splice(i, 1);
      }
    }
  }
  return null;
};

HasMany.prototype.addToCache = function(inst) {
  if (!inst) {
    return;
  }
  let cache = this.modelInstance.__cachedRelations[this.definition.name];
  if (cache === undefined) {
    cache = this.modelInstance.__cachedRelations[this.definition.name] = [];
  }
  const idName = this.definition.modelTo.definition.idName();
  if (Array.isArray(cache)) {
    for (let i = 0, n = cache.length; i < n; i++) {
      if (idEquals(cache[i][idName], inst[idName])) {
        cache[i] = inst;
        return;
      }
    }
    cache.push(inst);
  }
};

/**
 * HasManyThrough subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {HasManyThrough}
 * @constructor
 * @class HasManyThrough
 */
function HasManyThrough(definition, modelInstance) {
  if (!(this instanceof HasManyThrough)) {
    return new HasManyThrough(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.hasMany);
  assert(definition.modelThrough);
  HasMany.apply(this, arguments);
}

util.inherits(HasManyThrough, HasMany);

/**
 * BelongsTo subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {BelongsTo}
 * @constructor
 * @class BelongsTo
 */
function BelongsTo(definition, modelInstance) {
  if (!(this instanceof BelongsTo)) {
    return new BelongsTo(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.belongsTo);
  Relation.apply(this, arguments);
}

util.inherits(BelongsTo, Relation);

/**
 * HasAndBelongsToMany subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {HasAndBelongsToMany}
 * @constructor
 * @class HasAndBelongsToMany
 */
function HasAndBelongsToMany(definition, modelInstance) {
  if (!(this instanceof HasAndBelongsToMany)) {
    return new HasAndBelongsToMany(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.hasAndBelongsToMany);
  Relation.apply(this, arguments);
}

util.inherits(HasAndBelongsToMany, Relation);

/**
 * HasOne subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {HasOne}
 * @constructor
 * @class HasOne
 */
function HasOne(definition, modelInstance) {
  if (!(this instanceof HasOne)) {
    return new HasOne(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.hasOne);
  Relation.apply(this, arguments);
}

util.inherits(HasOne, Relation);

/**
 * EmbedsOne subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {EmbedsOne}
 * @constructor
 * @class EmbedsOne
 */
function EmbedsOne(definition, modelInstance) {
  if (!(this instanceof EmbedsOne)) {
    return new EmbedsOne(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.embedsOne);
  Relation.apply(this, arguments);
}

util.inherits(EmbedsOne, Relation);

/**
 * EmbedsMany subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {EmbedsMany}
 * @constructor
 * @class EmbedsMany
 */
function EmbedsMany(definition, modelInstance) {
  if (!(this instanceof EmbedsMany)) {
    return new EmbedsMany(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.embedsMany);
  Relation.apply(this, arguments);
}

util.inherits(EmbedsMany, Relation);

/**
 * ReferencesMany subclass
 * @param {RelationDefinition|Object} definition
 * @param {Object} modelInstance
 * @returns {ReferencesMany}
 * @constructor
 * @class ReferencesMany
 */
function ReferencesMany(definition, modelInstance) {
  if (!(this instanceof ReferencesMany)) {
    return new ReferencesMany(definition, modelInstance);
  }
  assert(definition.type === RelationTypes.referencesMany);
  Relation.apply(this, arguments);
}

util.inherits(ReferencesMany, Relation);

/*!
 * Find the relation by foreign key
 * @param {*} foreignKey The foreign key
 * @returns {Array} The array of matching relation objects
 */
function findBelongsTo(modelFrom, modelTo, keyTo) {
  return Object.keys(modelFrom.relations)
    .map(function(k) { return modelFrom.relations[k]; })
    .filter(function(rel) {
      return (rel.type === RelationTypes.belongsTo &&
              rel.modelTo === modelTo &&
              (keyTo === undefined || rel.keyTo === keyTo));
    })
    .map(function(rel) {
      return rel.keyFrom;
    });
}

/*!
 * Look up a model by name from the list of given models
 * @param {Object} models Models keyed by name
 * @param {String} modelName The model name
 * @returns {*} The matching model class
 */
function lookupModel(models, modelName) {
  if (models[modelName]) {
    return models[modelName];
  }
  const lookupClassName = modelName.toLowerCase();
  for (const name in models) {
    if (name.toLowerCase() === lookupClassName) {
      return models[name];
    }
  }
}

/*
 * @param {Object} modelFrom Instance of the 'from' model
 * @param {Object|String} modelToRef Reference to Model object to which you are
 *  creating the relation: model instance, model name, or name of relation to model.
 * @param {Object} params The relation params
 * @param {Boolean} singularize Whether the modelToRef should be singularized when
 *  looking-up modelTo
 * @return {Object} modelTo Instance of the 'to' model
 */
function lookupModelTo(modelFrom, modelToRef, params, singularize) {
  let modelTo;

  if (typeof modelToRef !== 'string') {
    // modelToRef might already be an instance of model
    modelTo = modelToRef;
  } else {
    // lookup modelTo based on relation params and modelToRef
    let modelToName;
    modelTo = params.model || modelToRef; // modelToRef might be modelTo name

    if (typeof modelTo === 'string') {
      // lookup modelTo by name
      modelToName = modelTo;
      modelToName = (singularize ? i8n.singularize(modelToName) : modelToName).toLowerCase();
      modelTo = lookupModel(modelFrom.dataSource.modelBuilder.models, modelToName);
    }

    if (!modelTo) {
      // lookup by modelTo name was not successful. Now looking-up by relationTo name
      const relationToName = params.as || modelToRef; // modelToRef might be relationTo name
      modelToName = (singularize ? i8n.singularize(relationToName) : relationToName).toLowerCase();
      modelTo = lookupModel(modelFrom.dataSource.modelBuilder.models, modelToName);
    }
  }
  if (typeof modelTo !== 'function') {
    throw new Error(g.f('Could not find relation %s for model %s', params.as, modelFrom.modelName));
  }
  return modelTo;
}

/*
 * Normalize relation's parameter `as`
 * @param {Object} params The relation params
 * @param {String} relationName The relation name
 * @returns {Object} The normalized parameters
 * NOTE: normalizeRelationAs() mutates the params object
 */
function normalizeRelationAs(params, relationName) {
  if (typeof relationName === 'string') {
    params.as = params.as || relationName;
  }
  return params;
}

/*
 * Normalize relation's polymorphic parameters
 * @param {Object|String|Boolean} polymorphic Param `polymorphic` of the relation.
 * @param {String} relationName The name of the relation we are currently setting up.
 * @returns {Object} The normalized parameters
 */
function normalizePolymorphic(polymorphic, relationName) {
  assert(polymorphic, 'polymorphic param can\'t be false, null or undefined');
  assert(!Array.isArray(polymorphic, 'unexpected type for polymorphic param: \'Array\''));

  let selector;

  if (typeof polymorphic === 'string') {
    // relation type is different from belongsTo (hasMany, hasManyThrough, hasAndBelongsToMany, ...)
    // polymorphic is the name of the matching belongsTo relation from modelTo to modelFrom
    selector = polymorphic;
  }

  if (polymorphic === true) {
    // relation type is belongsTo: the relation name is used as the polymorphic selector
    selector = relationName;
  }

  // NOTE: use of `polymorphic.as` keyword will be deprecated in LoopBack.next
  // to avoid confusion with keyword `as` used at the root of the relation definition object
  // It is replaced with the `polymorphic.selector` keyword
  if (typeof polymorphic == 'object') {
    selector = polymorphic.selector || polymorphic.as;
  }

  // relationName is eventually used as selector if provided and selector not already defined
  // it ultimately defaults to 'reference'
  selector = selector || relationName || 'reference';

  // make sure polymorphic is an object
  if (typeof polymorphic !== 'object') {
    polymorphic = {};
  }

  polymorphic.selector = selector;
  polymorphic.foreignKey = polymorphic.foreignKey || i8n.camelize(selector + '_id', true); // defaults to {{selector}}Id
  polymorphic.discriminator = polymorphic.discriminator || i8n.camelize(selector + '_type', true); // defaults to {{selectorName}}Type

  return polymorphic;
}

/**
 * Define a "one to many" relationship by specifying the model name
 *
 * Examples:
 * ```
 * User.hasMany(Post, {as: 'posts', foreignKey: 'authorId'});
 * ```
 *
 * ```
 * Book.hasMany(Chapter);
 * ```
 * Or, equivalently:
 * ```
 * Book.hasMany('chapters', {model: Chapter});
 * ```
 * @param {Model} modelFrom Source model class
 * @param {Object|String} modelToRef Reference to Model object to which you are
 *  creating the relation: model instance, model name, or name of relation to model.
 * @options {Object} params Configuration parameters; see below.
 * @property {String} as Name of the property in the referring model that corresponds to the foreign key field in the related model.
 * @property {String} foreignKey Property name of foreign key field.
 * @property {Object} model Model object
 */
RelationDefinition.hasMany = function hasMany(modelFrom, modelToRef, params) {
  const thisClassName = modelFrom.modelName;
  params = params || {};
  normalizeRelationAs(params, modelToRef);
  const modelTo = lookupModelTo(modelFrom, modelToRef, params, true);

  const relationName = params.as || i8n.camelize(modelTo.pluralModelName, true);
  let fk = params.foreignKey || i8n.camelize(thisClassName + '_id', true);
  let keyThrough = params.keyThrough || i8n.camelize(modelTo.modelName + '_id', true);

  const pkName = params.primaryKey || modelFrom.dataSource.idName(modelFrom.modelName) || 'id';
  let discriminator, polymorphic;

  if (params.polymorphic) {
    polymorphic = normalizePolymorphic(params.polymorphic, relationName);
    if (params.invert) {
      polymorphic.invert = true;
      keyThrough = polymorphic.foreignKey;
    }
    discriminator = polymorphic.discriminator;
    if (!params.invert) {
      fk = polymorphic.foreignKey;
    }
    if (!params.through) {
      modelTo.dataSource.defineProperty(modelTo.modelName, discriminator, {type: 'string', index: true});
    }
  }

  const definition = new RelationDefinition({
    name: relationName,
    type: RelationTypes.hasMany,
    modelFrom: modelFrom,
    keyFrom: pkName,
    keyTo: fk,
    modelTo: modelTo,
    multiple: true,
    properties: params.properties,
    scope: params.scope,
    options: params.options,
    keyThrough: keyThrough,
    polymorphic: polymorphic,
  });

  definition.modelThrough = params.through;

  modelFrom.relations[relationName] = definition;

  if (!params.through) {
    // obviously, modelTo should have attribute called `fk`
    // for polymorphic relations, it is assumed to share the same fk type for all
    // polymorphic models
    modelTo.dataSource.defineForeignKey(modelTo.modelName, fk, modelFrom.modelName, pkName);
  }

  const scopeMethods = {
    findById: scopeMethod(definition, 'findById'),
    destroy: scopeMethod(definition, 'destroyById'),
    updateById: scopeMethod(definition, 'updateById'),
    exists: scopeMethod(definition, 'exists'),
  };

  const findByIdFunc = scopeMethods.findById;
  modelFrom.prototype['__findById__' + relationName] = findByIdFunc;

  const destroyByIdFunc = scopeMethods.destroy;
  modelFrom.prototype['__destroyById__' + relationName] = destroyByIdFunc;

  const updateByIdFunc = scopeMethods.updateById;
  modelFrom.prototype['__updateById__' + relationName] = updateByIdFunc;

  const existsByIdFunc = scopeMethods.exists;
  modelFrom.prototype['__exists__' + relationName] = existsByIdFunc;

  if (definition.modelThrough) {
    scopeMethods.create = scopeMethod(definition, 'create');
    scopeMethods.add = scopeMethod(definition, 'add');
    scopeMethods.remove = scopeMethod(definition, 'remove');

    const addFunc = scopeMethods.add;
    modelFrom.prototype['__link__' + relationName] = addFunc;

    const removeFunc = scopeMethods.remove;
    modelFrom.prototype['__unlink__' + relationName] = removeFunc;
  } else {
    scopeMethods.create = scopeMethod(definition, 'create');
    scopeMethods.build = scopeMethod(definition, 'build');
  }

  const customMethods = extendScopeMethods(definition, scopeMethods, params.scopeMethods);

  for (let i = 0; i < customMethods.length; i++) {
    const methodName = customMethods[i];
    const method = scopeMethods[methodName];
    if (typeof method === 'function' && method.shared === true) {
      modelFrom.prototype['__' + methodName + '__' + relationName] = method;
    }
  }

  // Mix the property and scoped methods into the prototype class
  defineScope(modelFrom.prototype, params.through || modelTo, relationName, function() {
    const filter = {};
    filter.where = {};
    filter.where[fk] = this[pkName];

    definition.applyScope(this, filter);

    if (definition.modelThrough) {
      let throughRelationName;

      // find corresponding belongsTo relations from through model as collect
      for (const r in definition.modelThrough.relations) {
        const relation = definition.modelThrough.relations[r];

        // should be a belongsTo and match modelTo and keyThrough
        // if relation is polymorphic then check keyThrough only
        if (relation.type === RelationTypes.belongsTo &&
          (relation.polymorphic && !relation.modelTo || relation.modelTo === definition.modelTo) &&
          (relation.keyFrom === definition.keyThrough)
        ) {
          throughRelationName = relation.name;
          break;
        }
      }

      if (definition.polymorphic && definition.polymorphic.invert) {
        filter.collect = definition.polymorphic.selector;
        filter.include = filter.collect;
      } else {
        filter.collect = throughRelationName || i8n.camelize(modelTo.modelName, true);
        filter.include = filter.collect;
      }
    }

    return filter;
  }, scopeMethods, definition.options);

  return definition;
};

function scopeMethod(definition, methodName) {
  let relationClass = RelationClasses[definition.type];
  if (definition.type === RelationTypes.hasMany && definition.modelThrough) {
    relationClass = RelationClasses.hasManyThrough;
  }
  const method = function() {
    const relation = new relationClass(definition, this);
    return relation[methodName].apply(relation, arguments);
  };

  const relationMethod = relationClass.prototype[methodName];
  if (relationMethod.shared) {
    sharedMethod(definition, methodName, method, relationMethod);
  }
  return method;
}

function sharedMethod(definition, methodName, method, relationMethod) {
  method.shared = true;
  method.accepts = relationMethod.accepts;
  method.returns = relationMethod.returns;
  method.http = relationMethod.http;
  method.description = relationMethod.description;
}

/**
 * Find a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Object} [options] Options
 * @param {Function} cb The callback function
 */
HasMany.prototype.findById = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  const modelTo = this.definition.modelTo;
  const modelFrom = this.definition.modelFrom;
  const fk = this.definition.keyTo;
  const pk = this.definition.keyFrom;
  const modelInstance = this.modelInstance;

  const idName = this.definition.modelTo.definition.idName();
  const filter = {};
  filter.where = {};
  filter.where[idName] = fkId;
  filter.where[fk] = modelInstance[pk];

  cb = cb || utils.createPromiseCallback();

  if (filter.where[fk] === undefined) {
    // Foreign key is undefined
    process.nextTick(cb);
    return cb.promise;
  }
  this.definition.applyScope(modelInstance, filter);

  modelTo.findOne(filter, options, function(err, inst) {
    if (err) {
      return cb(err);
    }
    if (!inst) {
      err = new Error(g.f('No instance with {{id}} %s found for %s', fkId, modelTo.modelName));
      err.statusCode = 404;
      return cb(err);
    }
    // Check if the foreign key matches the primary key
    if (inst[fk] != null && idEquals(inst[fk], modelInstance[pk])) {
      cb(null, inst);
    } else {
      err = new Error(g.f('Key mismatch: %s.%s: %s, %s.%s: %s',
        modelFrom.modelName, pk, modelInstance[pk], modelTo.modelName, fk, inst[fk]));
      err.statusCode = 400;
      cb(err);
    }
  });
  return cb.promise;
};

/**
 * Find a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Object} [options] Options
 * @param {Function} cb The callback function
 */
HasMany.prototype.exists = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  const fk = this.definition.keyTo;
  const pk = this.definition.keyFrom;
  const modelInstance = this.modelInstance;
  cb = cb || utils.createPromiseCallback();

  this.findById(fkId, function(err, inst) {
    if (err) {
      return cb(err);
    }
    if (!inst) {
      return cb(null, false);
    }
    // Check if the foreign key matches the primary key
    if (inst[fk] && inst[fk].toString() === modelInstance[pk].toString()) {
      cb(null, true);
    } else {
      cb(null, false);
    }
  });
  return cb.promise;
};

/**
 * Update a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Object} Changes to the data
 * @param {Object} [options] Options
 * @param {Function} cb The callback function
 */
HasMany.prototype.updateById = function(fkId, data, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  cb = cb || utils.createPromiseCallback();
  const fk = this.definition.keyTo;

  this.findById(fkId, options, function(err, inst) {
    if (err) {
      return cb && cb(err);
    }
    // Ensure Foreign Key cannot be changed!
    const fkErr = preventFkOverride(inst, data, fk);
    if (fkErr) return cb(fkErr);
    inst.updateAttributes(data, options, cb);
  });
  return cb.promise;
};

/**
 * Delete a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Object} [options] Options
 * @param {Function} cb The callback function
 */
HasMany.prototype.destroyById = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  cb = cb || utils.createPromiseCallback();
  const self = this;
  this.findById(fkId, options, function(err, inst) {
    if (err) {
      return cb(err);
    }
    self.removeFromCache(fkId);
    inst.destroy(options, cb);
  });
  return cb.promise;
};

const throughKeys = function(definition) {
  const modelThrough = definition.modelThrough;
  const pk2 = definition.modelTo.definition.idName();

  let fk1, fk2;
  if (typeof definition.polymorphic === 'object') { // polymorphic
    fk1 = definition.keyTo;
    if (definition.polymorphic.invert) {
      fk2 = definition.polymorphic.foreignKey;
    } else {
      fk2 = definition.keyThrough;
    }
  } else if (definition.modelFrom === definition.modelTo) {
    return findBelongsTo(modelThrough, definition.modelTo, pk2).
      sort(function(fk1, fk2) {
        // Fix for bug - https://github.com/strongloop/loopback-datasource-juggler/issues/571
        // Make sure that first key is mapped to modelFrom
        // & second key to modelTo. Order matters
        return (definition.keyTo === fk1) ? -1 : 1;
      });
  } else {
    fk1 = findBelongsTo(modelThrough, definition.modelFrom,
      definition.keyFrom)[0];
    fk2 = findBelongsTo(modelThrough, definition.modelTo, pk2)[0];
  }
  return [fk1, fk2];
};

/**
 * Find a related item by foreign key
 * @param {*} fkId The foreign key value
 * @param {Object} [options] Options
 * @param {Function} cb The callback function
 */
HasManyThrough.prototype.findById = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  const self = this;
  const modelTo = this.definition.modelTo;
  const pk = this.definition.keyFrom;
  const modelInstance = this.modelInstance;
  const modelThrough = this.definition.modelThrough;

  cb = cb || utils.createPromiseCallback();

  self.exists(fkId, options, function(err, exists) {
    if (err || !exists) {
      if (!err) {
        err = new Error(g.f('No relation found in %s' +
          ' for (%s.%s,%s.%s)',
        modelThrough.modelName, self.definition.modelFrom.modelName,
        modelInstance[pk], modelTo.modelName, fkId));
        err.statusCode = 404;
      }
      return cb(err);
    }
    modelTo.findById(fkId, options, function(err, inst) {
      if (err) {
        return cb(err);
      }
      if (!inst) {
        err = new Error(g.f('No instance with id %s found for %s', fkId, modelTo.modelName));
        err.statusCode = 404;
        return cb(err);
      }
      cb(err, inst);
    });
  });
  return cb.promise;
};

/**
 * Delete a related item by foreign key
 * @param {*} fkId The foreign key
 * @param {Object} [options] Options
 * @param {Function} cb The callback function
 */
HasManyThrough.prototype.destroyById = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  const self = this;
  const modelTo = this.definition.modelTo;
  const pk = this.definition.keyFrom;
  const modelInstance = this.modelInstance;
  const modelThrough = this.definition.modelThrough;

  cb = cb || utils.createPromiseCallback();

  self.exists(fkId, options, function(err, exists) {
    if (err || !exists) {
      if (!err) {
        err = new Error(g.f('No record found in %s for (%s.%s ,%s.%s)',
          modelThrough.modelName, self.definition.modelFrom.modelName,
          modelInstance[pk], modelTo.modelName, fkId));
        err.statusCode = 404;
      }
      return cb(err);
    }
    self.remove(fkId, options, function(err) {
      if (err) {
        return cb(err);
      }
      modelTo.deleteById(fkId, options, cb);
    });
  });
  return cb.promise;
};

// Create an instance of the target model and connect it to the instance of
// the source model by creating an instance of the through model
HasManyThrough.prototype.create = function create(data, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  const self = this;
  const definition = this.definition;
  const modelTo = definition.modelTo;
  const modelThrough = definition.modelThrough;

  if (typeof data === 'function' && !cb) {
    cb = data;
    data = {};
  }
  cb = cb || utils.createPromiseCallback();

  const modelInstance = this.modelInstance;

  // First create the target model
  modelTo.create(data, options, function(err, to) {
    if (err) {
      return cb(err, to);
    }
    // The primary key for the target model
    const pk2 = definition.modelTo.definition.idName();
    const keys = throughKeys(definition);
    const fk1 = keys[0];
    const fk2 = keys[1];

    function createRelation(to, next) {
      const d = {}, q = {}, filter = {where: q};
      d[fk1] = q[fk1] = modelInstance[definition.keyFrom];
      d[fk2] = q[fk2] = to[pk2];
      definition.applyProperties(modelInstance, d);
      definition.applyScope(modelInstance, filter);

      // Then create the through model
      modelThrough.findOrCreate(filter, d, options, function(e, through) {
        if (e) {
          // Undo creation of the target model
          to.destroy(options, function() {
            next(e);
          });
        } else {
          self.addToCache(to);
          next(err, to);
        }
      });
    }

    // process array or single item
    if (!Array.isArray(to))
      createRelation(to, cb);
    else
      async.map(to, createRelation, cb);
  });
  return cb.promise;
};

/**
 * Add the target model instance to the 'hasMany' relation
 * @param {Object|ID} acInst The actual instance or id value
 * @param {Object} [data] Optional data object for the through model to be created
 * @param {Object} [options] Options
 * @param {Function} [cb] Callback function
 */
HasManyThrough.prototype.add = function(acInst, data, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  const self = this;
  const definition = this.definition;
  const modelThrough = definition.modelThrough;
  const pk1 = definition.keyFrom;

  if (typeof data === 'function') {
    cb = data;
    data = {};
  }
  const query = {};

  data = data || {};
  cb = cb || utils.createPromiseCallback();

  // The primary key for the target model
  const pk2 = definition.modelTo.definition.idName();

  const keys = throughKeys(definition);
  const fk1 = keys[0];
  const fk2 = keys[1];

  query[fk1] = this.modelInstance[pk1];
  query[fk2] = (acInst instanceof definition.modelTo) ? acInst[pk2] : acInst;

  const filter = {where: query};

  definition.applyScope(this.modelInstance, filter);

  data[fk1] = this.modelInstance[pk1];
  data[fk2] = (acInst instanceof definition.modelTo) ? acInst[pk2] : acInst;

  definition.applyProperties(this.modelInstance, data);

  // Create an instance of the through model
  modelThrough.findOrCreate(filter, data, options, function(err, ac) {
    if (!err) {
      if (acInst instanceof definition.modelTo) {
        self.addToCache(acInst);
      }
    }
    cb(err, ac);
  });
  return cb.promise;
};

/**
 * Check if the target model instance is related to the 'hasMany' relation
 * @param {Object|ID} acInst The actual instance or id value
 */
HasManyThrough.prototype.exists = function(acInst, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  const definition = this.definition;
  const modelThrough = definition.modelThrough;
  const pk1 = definition.keyFrom;

  const query = {};

  // The primary key for the target model
  const pk2 = definition.modelTo.definition.idName();

  const keys = throughKeys(definition);
  const fk1 = keys[0];
  const fk2 = keys[1];

  query[fk1] = this.modelInstance[pk1];
  query[fk2] = (acInst instanceof definition.modelTo) ? acInst[pk2] : acInst;

  const filter = {where: query};

  definition.applyScope(this.modelInstance, filter);

  cb = cb || utils.createPromiseCallback();

  modelThrough.count(filter.where, options, function(err, ac) {
    cb(err, ac > 0);
  });
  return cb.promise;
};

/**
 * Remove the target model instance from the 'hasMany' relation
 * @param {Object|ID) acInst The actual instance or id value
 */
HasManyThrough.prototype.remove = function(acInst, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  const self = this;
  const definition = this.definition;
  const modelThrough = definition.modelThrough;
  const pk1 = definition.keyFrom;

  const query = {};

  // The primary key for the target model
  const pk2 = definition.modelTo.definition.idName();

  const keys = throughKeys(definition);
  const fk1 = keys[0];
  const fk2 = keys[1];

  query[fk1] = this.modelInstance[pk1];
  query[fk2] = (acInst instanceof definition.modelTo) ? acInst[pk2] : acInst;

  const filter = {where: query};

  definition.applyScope(this.modelInstance, filter);

  cb = cb || utils.createPromiseCallback();

  modelThrough.deleteAll(filter.where, options, function(err) {
    if (!err) {
      self.removeFromCache(query[fk2]);
    }
    cb(err);
  });
  return cb.promise;
};

/**
 * Declare "belongsTo" relation that sets up a one-to-one connection with
 * another model, such that each instance of the declaring model "belongs to"
 * one instance of the other model.
 *
 * For example, if an application includes users and posts, and each post can
 * be written by exactly one user. The following code specifies that `Post` has
 * a reference called `author` to the `User` model via the `userId` property of
 * `Post` as the foreign key.
 * ```
 * Post.belongsTo(User, {as: 'author', foreignKey: 'userId'});
 * ```
 *
 * This optional parameter default value is false, so the related object will
 * be loaded from cache if available.
 *
 * @param {Object|String} modelToRef Reference to Model object to which you are
 *  creating the relation: model instance, model name, or name of relation to model.
 * @options {Object} params Configuration parameters; see below.
 * @property {String} as Name of the property in the referring model that
 * corresponds to the foreign key field in the related model.
 * @property {String} foreignKey Name of foreign key property.
 *
 */
RelationDefinition.belongsTo = function(modelFrom, modelToRef, params) {
  let modelTo, discriminator, polymorphic;
  params = params || {};

  let pkName, relationName, fk;
  if (params.polymorphic) {
    relationName = params.as || (typeof modelToRef === 'string' ? modelToRef : null);
    polymorphic = normalizePolymorphic(params.polymorphic, relationName);

    modelTo = null; // will be looked-up dynamically

    pkName = params.primaryKey || params.idName || 'id';
    fk = polymorphic.foreignKey;
    discriminator = polymorphic.discriminator;

    if (polymorphic.idType) { // explicit key type
      modelFrom.dataSource.defineProperty(modelFrom.modelName, fk, {type: polymorphic.idType, index: true});
    } else { // try to use the same foreign key type as modelFrom
      modelFrom.dataSource.defineForeignKey(modelFrom.modelName, fk, modelFrom.modelName, pkName);
    }

    modelFrom.dataSource.defineProperty(modelFrom.modelName, discriminator, {type: 'string', index: true});
  } else {
    // relation is not polymorphic
    normalizeRelationAs(params, modelToRef);
    modelTo = lookupModelTo(modelFrom, modelToRef, params);
    pkName = params.primaryKey || modelTo.dataSource.idName(modelTo.modelName) || 'id';
    relationName = params.as || i8n.camelize(modelTo.modelName, true);
    fk = params.foreignKey || relationName + 'Id';

    modelFrom.dataSource.defineForeignKey(modelFrom.modelName, fk, modelTo.modelName, pkName);
  }

  const definition = modelFrom.relations[relationName] = new RelationDefinition({
    name: relationName,
    type: RelationTypes.belongsTo,
    modelFrom: modelFrom,
    keyFrom: fk,
    keyTo: pkName,
    modelTo: modelTo,
    multiple: false,
    properties: params.properties,
    scope: params.scope,
    options: params.options,
    polymorphic: polymorphic,
    methods: params.methods,
  });

  // Define a property for the scope so that we have 'this' for the scoped methods
  Object.defineProperty(modelFrom.prototype, relationName, {
    enumerable: true,
    configurable: true,
    get: function() {
      const relation = new BelongsTo(definition, this);
      const relationMethod = relation.related.bind(relation);
      relationMethod.get = relation.get.bind(relation);
      relationMethod.getAsync = function() {
        deprecated(g.f('BelongsTo method "getAsync()" is deprecated, use "get()" instead.'));
        return this.get.apply(this, arguments);
      };
      relationMethod.update = relation.update.bind(relation);
      relationMethod.destroy = relation.destroy.bind(relation);
      if (!polymorphic) {
        relationMethod.create = relation.create.bind(relation);
        relationMethod.build = relation.build.bind(relation);
        relationMethod._targetClass = definition.modelTo.modelName;
      }
      bindRelationMethods(relation, relationMethod, definition);
      return relationMethod;
    },
  });

  // FIXME: [rfeng] Wrap the property into a function for remoting
  // so that it can be accessed as /api/<model>/<id>/<belongsToRelationName>
  // For example, /api/orders/1/customer
  const fn = function() {
    const f = this[relationName];
    f.apply(this, arguments);
  };
  modelFrom.prototype['__get__' + relationName] = fn;

  return definition;
};

BelongsTo.prototype.create = function(targetModelData, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  const self = this;
  const modelTo = this.definition.modelTo;
  const fk = this.definition.keyFrom;
  const pk = this.definition.keyTo;
  const modelInstance = this.modelInstance;

  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }
  cb = cb || utils.createPromiseCallback();

  this.definition.applyProperties(modelInstance, targetModelData || {});

  modelTo.create(targetModelData, options, function(err, targetModel) {
    if (!err) {
      modelInstance[fk] = targetModel[pk];
      if (modelInstance.isNewRecord()) {
        self.resetCache(targetModel);
        cb && cb(err, targetModel);
      } else {
        modelInstance.save(options, function(err, inst) {
          if (cb && err) return cb && cb(err);
          self.resetCache(targetModel);
          cb && cb(err, targetModel);
        });
      }
    } else {
      cb && cb(err);
    }
  });
  return cb.promise;
};

BelongsTo.prototype.build = function(targetModelData) {
  const modelTo = this.definition.modelTo;
  this.definition.applyProperties(this.modelInstance, targetModelData || {});
  return new modelTo(targetModelData);
};

BelongsTo.prototype.update = function(targetModelData, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  cb = cb || utils.createPromiseCallback();
  const definition = this.definition;
  const fk = definition.keyTo;

  this.fetch(options, function(err, inst) {
    if (inst instanceof ModelBaseClass) {
      // Ensures Foreign Key cannot be changed!
      const fkErr = preventFkOverride(inst, targetModelData, fk);
      if (fkErr) return cb(fkErr);
      inst.updateAttributes(targetModelData, options, cb);
    } else {
      cb(new Error(g.f('{{BelongsTo}} relation %s is empty', definition.name)));
    }
  });
  return cb.promise;
};

BelongsTo.prototype.destroy = function(options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }

  const definition = this.definition;
  const modelInstance = this.modelInstance;
  const fk = definition.keyFrom;

  cb = cb || utils.createPromiseCallback();

  this.fetch(options, function(err, targetModel) {
    if (targetModel instanceof ModelBaseClass) {
      modelInstance[fk] = null;
      modelInstance.save(options, function(err, targetModel) {
        if (cb && err) return cb && cb(err);
        cb && cb(err, targetModel);
      });
    } else {
      cb(new Error(g.f('{{BelongsTo}} relation %s is empty', definition.name)));
    }
  });
  return cb.promise;
};

/**
 * Define the method for the belongsTo relation itself
 * It will support one of the following styles:
 * - order.customer(refresh, options, callback): Load the target model instance asynchronously
 * - order.customer(customer): Synchronous setter of the target model instance
 * - order.customer(): Synchronous getter of the target model instance
 *
 * @param refresh
 * @param params
 * @returns {*}
 */
BelongsTo.prototype.related = function(condOrRefresh, options, cb) {
  const self = this;
  const modelFrom = this.definition.modelFrom;
  let modelTo = this.definition.modelTo;
  const pk = this.definition.keyTo;
  const fk = this.definition.keyFrom;
  const modelInstance = this.modelInstance;
  let discriminator;
  let scopeQuery = null;
  let newValue;

  if ((condOrRefresh instanceof ModelBaseClass) &&
    options === undefined && cb === undefined) {
    // order.customer(customer)
    newValue = condOrRefresh;
    condOrRefresh = false;
  } else if (typeof condOrRefresh === 'function' &&
    options === undefined && cb === undefined) {
    // order.customer(cb)
    cb = condOrRefresh;
    condOrRefresh = false;
  } else if (typeof options === 'function' && cb === undefined) {
    // order.customer(condOrRefresh, cb)
    cb = options;
    options = {};
  }
  if (!newValue) {
    scopeQuery = condOrRefresh;
  }

  if (typeof this.definition.polymorphic === 'object') {
    discriminator = this.definition.polymorphic.discriminator;
  }

  let cachedValue;
  if (!condOrRefresh) {
    cachedValue = self.getCache();
  }
  if (newValue) { // acts as setter
    modelInstance[fk] = newValue[pk];

    if (discriminator) {
      modelInstance[discriminator] = newValue.constructor.modelName;
    }

    this.definition.applyProperties(modelInstance, newValue);

    self.resetCache(newValue);
  } else if (typeof cb === 'function') { // acts as async getter
    if (discriminator) {
      let modelToName = modelInstance[discriminator];
      if (typeof modelToName !== 'string') {
        throw new Error(g.f('{{Polymorphic}} model not found: `%s` not set', discriminator));
      }
      modelToName = modelToName.toLowerCase();
      modelTo = lookupModel(modelFrom.dataSource.modelBuilder.models, modelToName);
      if (!modelTo) {
        throw new Error(g.f('{{Polymorphic}} model not found: `%s`', modelToName));
      }
    }

    if (cachedValue === undefined || !(cachedValue instanceof ModelBaseClass)) {
      const query = {where: {}};
      query.where[pk] = modelInstance[fk];

      if (query.where[pk] === undefined || query.where[pk] === null) {
        // Foreign key is undefined
        return process.nextTick(cb);
      }

      this.definition.applyScope(modelInstance, query);

      if (scopeQuery) mergeQuery(query, scopeQuery);

      if (Array.isArray(query.fields) && query.fields.indexOf(pk) === -1) {
        query.fields.push(pk); // always include the pk
      }

      modelTo.findOne(query, options, function(err, inst) {
        if (err) {
          return cb(err);
        }
        if (!inst) {
          return cb(null, null);
        }
        // Check if the foreign key matches the primary key
        if (inst[pk] != null && modelInstance[fk] != null &&
            inst[pk].toString() === modelInstance[fk].toString()) {
          self.resetCache(inst);
          cb(null, inst);
        } else {
          err = new Error(g.f('Key mismatch: %s.%s: %s, %s.%s: %s',
            self.definition.modelFrom.modelName, fk, modelInstance[fk],
            modelTo.modelName, pk, inst[pk]));
          err.statusCode = 400;
          cb(err);
        }
      });
      return modelInstance[fk];
    } else {
      cb(null, cachedValue);
      return cachedValue;
    }
  } else if (condOrRefresh === undefined) { // acts as sync getter
    return cachedValue;
  } else { // setter
    modelInstance[fk] = newValue;
    self.resetCache();
  }
};

/**
 * Define a Promise-based method for the belongsTo relation itself
 * - order.customer.get(cb): Load the target model instance asynchronously
 *
 * @param {Function} cb Callback of the form function (err, inst)
 * @returns {Promise | Undefined} returns promise if callback is omitted
 */
BelongsTo.prototype.get = function(options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  cb = cb || utils.createPromiseCallback();
  this.related(true, options, cb);
  return cb.promise;
};

/**
 * A hasAndBelongsToMany relation creates a direct many-to-many connection with
 * another model, with no intervening model. For example, if your application
 * includes users and groups, with each group having many users and each user
 * appearing in many groups, you could declare the models this way:
 * ```
 *  User.hasAndBelongsToMany('groups', {model: Group, foreignKey: 'groupId'});
 * ```
 *
 * @param {Object|String} modelToRef Reference to Model object to which you are
 *  creating the relation: model instance, model name, or name of relation to model.
 * @options {Object} params Configuration parameters; see below.
 * @property {String} as Name of the property in the referring model that
 * corresponds to the foreign key field in the related model.
 * @property {String} foreignKey Property name of foreign key field.
 * @property {Object} model Model object
 */
RelationDefinition.hasAndBelongsToMany = function hasAndBelongsToMany(modelFrom, modelToRef, params) {
  params = params || {};
  normalizeRelationAs(params, modelToRef);
  const modelTo = lookupModelTo(modelFrom, modelToRef, params, true);

  const models = modelFrom.dataSource.modelBuilder.models;

  if (!params.through) {
    if (params.polymorphic) throw new Error(g.f('{{Polymorphic}} relations need a through model'));

    if (params.throughTable) {
      params.through = modelFrom.dataSource.define(params.throughTable);
    } else {
      const name1 = modelFrom.modelName + modelTo.modelName;
      const name2 = modelTo.modelName + modelFrom.modelName;
      params.through = lookupModel(models, name1) || lookupModel(models, name2) ||
        modelFrom.dataSource.define(name1);
    }
  }

  const options = {as: params.as, through: params.through};
  options.properties = params.properties;
  options.scope = params.scope;

  // Forward relation options like "disableInclude"
  options.options = params.options;

  if (params.polymorphic) {
    const relationName = params.as || i8n.camelize(modelTo.pluralModelName, true);
    const polymorphic = normalizePolymorphic(params.polymorphic, relationName);
    options.polymorphic = polymorphic; // pass through
    const accessor = params.through.prototype[polymorphic.selector];
    if (typeof accessor !== 'function') { // declare once
      // use the name of the polymorphic selector, not modelTo
      params.through.belongsTo(polymorphic.selector, {polymorphic: true});
    }
  } else {
    params.through.belongsTo(modelFrom);
  }

  params.through.belongsTo(modelTo);

  return this.hasMany(modelFrom, modelTo, options);
};

/**
 * A HasOne relation creates a one-to-one connection from modelFrom to modelTo.
 * This relation indicates that each instance of a model contains or possesses
 * one instance of another model. For example, each supplier in your application
 * has only one account.
 *
 * @param {Function} modelFrom The declaring model class
 * @param {Object|String} modelToRef Reference to Model object to which you are
 *  creating the relation: model instance, model name, or name of relation to model.
 * @options {Object} params Configuration parameters; see below.
 * @property {String} as Name of the property in the referring model that
 * corresponds to the foreign key field in the related model.
 * @property {String} foreignKey Property name of foreign key field.
 * @property {Object} model Model object
 */
RelationDefinition.hasOne = function(modelFrom, modelToRef, params) {
  params = params || {};
  normalizeRelationAs(params, modelToRef);
  const modelTo = lookupModelTo(modelFrom, modelToRef, params);

  const pk = params.primaryKey || modelFrom.dataSource.idName(modelFrom.modelName) || 'id';
  const relationName = params.as || i8n.camelize(modelTo.modelName, true);

  let fk = params.foreignKey || i8n.camelize(modelFrom.modelName + '_id', true);
  let discriminator, polymorphic;

  if (params.polymorphic) {
    polymorphic = normalizePolymorphic(params.polymorphic, relationName);
    fk = polymorphic.foreignKey;
    discriminator = polymorphic.discriminator;
    if (!params.through) {
      modelTo.dataSource.defineProperty(modelTo.modelName, discriminator, {type: 'string', index: true});
    }
  }

  const definition = modelFrom.relations[relationName] = new RelationDefinition({
    name: relationName,
    type: RelationTypes.hasOne,
    modelFrom: modelFrom,
    keyFrom: pk,
    keyTo: fk,
    modelTo: modelTo,
    multiple: false,
    properties: params.properties,
    scope: params.scope,
    options: params.options,
    polymorphic: polymorphic,
    methods: params.methods,
  });

  modelTo.dataSource.defineForeignKey(modelTo.modelName, fk, modelFrom.modelName, pk);

  // Define a property for the scope so that we have 'this' for the scoped methods
  Object.defineProperty(modelFrom.prototype, relationName, {
    enumerable: true,
    configurable: true,
    get: function() {
      const relation = new HasOne(definition, this);
      const relationMethod = relation.related.bind(relation);
      relationMethod.get = relation.get.bind(relation);
      relationMethod.getAsync = function() {
        deprecated(g.f('HasOne method "getAsync()" is deprecated, use "get()" instead.'));
        return this.get.apply(this, arguments);
      };
      relationMethod.create = relation.create.bind(relation);
      relationMethod.build = relation.build.bind(relation);
      relationMethod.update = relation.update.bind(relation);
      relationMethod.destroy = relation.destroy.bind(relation);
      relationMethod._targetClass = definition.modelTo.modelName;
      bindRelationMethods(relation, relationMethod, definition);
      return relationMethod;
    },
  });

  // FIXME: [rfeng] Wrap the property into a function for remoting
  // so that it can be accessed as /api/<model>/<id>/<hasOneRelationName>
  // For example, /api/orders/1/customer
  modelFrom.prototype['__get__' + relationName] = function() {
    const f = this[relationName];
    f.apply(this, arguments);
  };

  modelFrom.prototype['__create__' + relationName] = function() {
    const f = this[relationName].create;
    f.apply(this, arguments);
  };

  modelFrom.prototype['__update__' + relationName] = function() {
    const f = this[relationName].update;
    f.apply(this, arguments);
  };

  modelFrom.prototype['__destroy__' + relationName] = function() {
    const f = this[relationName].destroy;
    f.apply(this, arguments);
  };

  return definition;
};

/**
 * Create a target model instance
 * @param {Object} targetModelData The target model data
 * @callback {Function} [cb] Callback function
 * @param {String|Object} err Error string or object
 * @param {Object} The newly created target model instance
 */
HasOne.prototype.create = function(targetModelData, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.profile.create(options, cb)
    cb = options;
    options = {};
  }
  const self = this;
  const modelTo = this.definition.modelTo;
  const fk = this.definition.keyTo;
  const pk = this.definition.keyFrom;
  const modelInstance = this.modelInstance;

  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }
  targetModelData = targetModelData || {};
  cb = cb || utils.createPromiseCallback();

  targetModelData[fk] = modelInstance[pk];
  const query = {where: {}};
  query.where[fk] = targetModelData[fk];

  this.definition.applyScope(modelInstance, query);
  this.definition.applyProperties(modelInstance, targetModelData);

  modelTo.findOrCreate(query, targetModelData, options,
    function(err, targetModel, created) {
      if (err) {
        return cb && cb(err);
      }
      if (created) {
        // Refresh the cache
        self.resetCache(targetModel);
        cb && cb(err, targetModel);
      } else {
        cb && cb(new Error(g.f(
          '{{HasOne}} relation cannot create more than one instance of %s',
          modelTo.modelName,
        )));
      }
    });
  return cb.promise;
};

HasOne.prototype.update = function(targetModelData, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.profile.update(data, cb)
    cb = options;
    options = {};
  }
  cb = cb || utils.createPromiseCallback();
  const definition = this.definition;
  const fk = this.definition.keyTo;
  this.fetch(function(err, targetModel) {
    if (targetModel instanceof ModelBaseClass) {
      // Ensures Foreign Key cannot be changed!
      const fkErr = preventFkOverride(targetModel, targetModelData, fk);
      if (fkErr) return cb(fkErr);
      targetModel.updateAttributes(targetModelData, options, cb);
    } else {
      cb(new Error(g.f('{{HasOne}} relation %s is empty', definition.name)));
    }
  });
  return cb.promise;
};

HasOne.prototype.destroy = function(options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.profile.destroy(cb)
    cb = options;
    options = {};
  }
  cb = cb || utils.createPromiseCallback();
  const definition = this.definition;
  this.fetch(function(err, targetModel) {
    if (targetModel instanceof ModelBaseClass) {
      targetModel.destroy(options, cb);
    } else {
      cb(new Error(g.f('{{HasOne}} relation %s is empty', definition.name)));
    }
  });
  return cb.promise;
};

/**
 * Create a target model instance
 * @param {Object} targetModelData The target model data
 * @callback {Function} [cb] Callback function
 * @param {String|Object} err Error string or object
 * @param {Object} The newly created target model instance
 */
HasMany.prototype.create = function(targetModelData, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.orders.create(data, cb)
    cb = options;
    options = {};
  }
  const self = this;
  const modelTo = this.definition.modelTo;
  const fk = this.definition.keyTo;
  const pk = this.definition.keyFrom;
  const modelInstance = this.modelInstance;

  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }
  targetModelData = targetModelData || {};
  cb = cb || utils.createPromiseCallback();

  const fkAndProps = function(item) {
    item[fk] = modelInstance[pk];
    self.definition.applyProperties(modelInstance, item);
  };

  const apply = function(data, fn) {
    if (Array.isArray(data)) {
      data.forEach(fn);
    } else {
      fn(data);
    }
  };

  apply(targetModelData, fkAndProps);

  modelTo.create(targetModelData, options, function(err, targetModel) {
    if (!err) {
      // Refresh the cache
      apply(targetModel, self.addToCache.bind(self));
      cb && cb(err, targetModel);
    } else {
      cb && cb(err);
    }
  });
  return cb.promise;
};
/**
 * Build a target model instance
 * @param {Object} targetModelData The target model data
 * @returns {Object} The newly built target model instance
 */
HasMany.prototype.build = HasOne.prototype.build = function(targetModelData) {
  const modelTo = this.definition.modelTo;
  const pk = this.definition.keyFrom;
  const fk = this.definition.keyTo;

  targetModelData = targetModelData || {};
  targetModelData[fk] = this.modelInstance[pk];

  this.definition.applyProperties(this.modelInstance, targetModelData);

  return new modelTo(targetModelData);
};

/**
 * Define the method for the hasOne relation itself
 * It will support one of the following styles:
 * - order.customer(refresh, callback): Load the target model instance asynchronously
 * - order.customer(customer): Synchronous setter of the target model instance
 * - order.customer(): Synchronous getter of the target model instance
 *
 * @param {Boolean} refresh Reload from the data source
 * @param {Object|Function} params Query parameters
 * @returns {Object}
 */
HasOne.prototype.related = function(condOrRefresh, options, cb) {
  const self = this;
  const modelTo = this.definition.modelTo;
  const fk = this.definition.keyTo;
  const pk = this.definition.keyFrom;
  const definition = this.definition;
  const modelInstance = this.modelInstance;
  let newValue;

  if ((condOrRefresh instanceof ModelBaseClass) &&
    options === undefined && cb === undefined) {
    // order.customer(customer)
    newValue = condOrRefresh;
    condOrRefresh = false;
  } else if (typeof condOrRefresh === 'function' &&
    options === undefined && cb === undefined) {
    // customer.profile(cb)
    cb = condOrRefresh;
    condOrRefresh = false;
  } else if (typeof options === 'function' && cb === undefined) {
    // customer.profile(condOrRefresh, cb)
    cb = options;
    options = {};
  }

  let cachedValue;
  if (!condOrRefresh) {
    cachedValue = self.getCache();
  }
  if (newValue) { // acts as setter
    newValue[fk] = modelInstance[pk];
    self.resetCache(newValue);
  } else if (typeof cb === 'function') { // acts as async getter
    if (cachedValue === undefined) {
      const query = {where: {}};
      query.where[fk] = modelInstance[pk];
      definition.applyScope(modelInstance, query);
      modelTo.findOne(query, options, function(err, inst) {
        if (err) {
          return cb(err);
        }
        if (!inst) {
          return cb(null, null);
        }
        // Check if the foreign key matches the primary key
        if (inst[fk] != null && modelInstance[pk] != null &&
            inst[fk].toString() === modelInstance[pk].toString()) {
          self.resetCache(inst);
          cb(null, inst);
        } else {
          err = new Error(g.f('Key mismatch: %s.%s: %s, %s.%s: %s',
            self.definition.modelFrom.modelName, pk, modelInstance[pk],
            modelTo.modelName, fk, inst[fk]));
          err.statusCode = 400;
          cb(err);
        }
      });
      return modelInstance[pk];
    } else {
      cb(null, cachedValue);
      return cachedValue;
    }
  } else if (condOrRefresh === undefined) { // acts as sync getter
    return cachedValue;
  } else { // setter
    newValue[fk] = modelInstance[pk];
    self.resetCache();
  }
};

/**
 * Define a Promise-based method for the hasOne relation itself
 * - order.customer.get(cb): Load the target model instance asynchronously
 *
 * @param {Function} cb Callback of the form function (err, inst)
 * @returns {Promise | Undefined} Returns promise if cb is omitted
 */
HasOne.prototype.get = function(options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    cb = options;
    options = {};
  }
  cb = cb || utils.createPromiseCallback();
  this.related(true, cb);
  return cb.promise;
};

RelationDefinition.embedsOne = function(modelFrom, modelToRef, params) {
  params = params || {};
  normalizeRelationAs(params, modelToRef);
  const modelTo = lookupModelTo(modelFrom, modelToRef, params);

  const thisClassName = modelFrom.modelName;
  const relationName = params.as || (i8n.camelize(modelTo.modelName, true) + 'Item');
  let propertyName = params.property || i8n.camelize(modelTo.modelName, true);
  const idName = modelTo.dataSource.idName(modelTo.modelName) || 'id';

  if (relationName === propertyName) {
    propertyName = '_' + propertyName;
    debug('EmbedsOne property cannot be equal to relation name: ' +
      'forcing property %s for relation %s', propertyName, relationName);
  }

  const definition = modelFrom.relations[relationName] = new RelationDefinition({
    name: relationName,
    type: RelationTypes.embedsOne,
    modelFrom: modelFrom,
    keyFrom: propertyName,
    keyTo: idName,
    modelTo: modelTo,
    multiple: false,
    properties: params.properties,
    scope: params.scope,
    options: params.options,
    embed: true,
    methods: params.methods,
  });

  const opts = Object.assign(
    params.options && params.options.property ? params.options.property : {},
    {type: modelTo},
  );

  if (params.default === true) {
    opts.default = function() { return new modelTo(); };
  } else if (typeof params.default === 'object') {
    opts.default = (function(def) {
      return function() {
        return new modelTo(def);
      };
    }(params.default));
  }

  modelFrom.dataSource.defineProperty(modelFrom.modelName, propertyName, opts);

  // validate the embedded instance
  if (definition.options.validate !== false) {
    modelFrom.validate(relationName, function(err) {
      const inst = this[propertyName];
      if (inst instanceof modelTo) {
        if (!inst.isValid()) {
          const first = Object.keys(inst.errors)[0];
          const msg = 'is invalid: `' + first + '` ' + inst.errors[first];
          this.errors.add(relationName, msg, 'invalid');
          err(false);
        }
      }
    });
  }

  // Define a property for the scope so that we have 'this' for the scoped methods
  Object.defineProperty(modelFrom.prototype, relationName, {
    enumerable: true,
    configurable: true,
    get: function() {
      const relation = new EmbedsOne(definition, this);
      const relationMethod = relation.related.bind(relation);
      relationMethod.create = relation.create.bind(relation);
      relationMethod.build = relation.build.bind(relation);
      relationMethod.update = relation.update.bind(relation);
      relationMethod.destroy = relation.destroy.bind(relation);
      relationMethod.value = relation.embeddedValue.bind(relation);
      relationMethod._targetClass = definition.modelTo.modelName;
      bindRelationMethods(relation, relationMethod, definition);
      return relationMethod;
    },
  });

  // FIXME: [rfeng] Wrap the property into a function for remoting
  // so that it can be accessed as /api/<model>/<id>/<embedsOneRelationName>
  // For example, /api/orders/1/customer
  modelFrom.prototype['__get__' + relationName] = function() {
    const f = this[relationName];
    f.apply(this, arguments);
  };

  modelFrom.prototype['__create__' + relationName] = function() {
    const f = this[relationName].create;
    f.apply(this, arguments);
  };

  modelFrom.prototype['__update__' + relationName] = function() {
    const f = this[relationName].update;
    f.apply(this, arguments);
  };

  modelFrom.prototype['__destroy__' + relationName] = function() {
    const f = this[relationName].destroy;
    f.apply(this, arguments);
  };

  return definition;
};

EmbedsOne.prototype.related = function(condOrRefresh, options, cb) {
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;
  const propertyName = this.definition.keyFrom;
  let newValue;

  if ((condOrRefresh instanceof ModelBaseClass) &&
    options === undefined && cb === undefined) {
    // order.customer(customer)
    newValue = condOrRefresh;
    condOrRefresh = false;
  } else if (typeof condOrRefresh === 'function' &&
    options === undefined && cb === undefined) {
    // order.customer(cb)
    cb = condOrRefresh;
    condOrRefresh = false;
  } else if (typeof options === 'function' && cb === undefined) {
    // order.customer(condOrRefresh, cb)
    cb = options;
    options = {};
  }

  if (newValue) { // acts as setter
    if (newValue instanceof modelTo) {
      this.definition.applyProperties(modelInstance, newValue);
      modelInstance.setAttribute(propertyName, newValue);
    }
    return;
  }

  const embeddedInstance = this.embeddedValue();

  if (embeddedInstance) {
    embeddedInstance.__persisted = true;
  }

  if (typeof cb === 'function') { // acts as async getter
    process.nextTick(function() {
      cb(null, embeddedInstance);
    });
  } else if (condOrRefresh === undefined) { // acts as sync getter
    return embeddedInstance;
  }
};

EmbedsOne.prototype.prepareEmbeddedInstance = function(inst) {
  if (inst && inst.triggerParent !== 'function') {
    const self = this;
    const propertyName = this.definition.keyFrom;
    const modelInstance = this.modelInstance;
    if (this.definition.options.persistent) {
      const pk = this.definition.keyTo;
      inst.__persisted = !!inst[pk];
    } else {
      inst.__persisted = true;
    }
    inst.triggerParent = function(actionName, callback) {
      if (actionName === 'save') {
        const embeddedValue = self.embeddedValue();
        modelInstance.updateAttribute(propertyName,
          embeddedValue, function(err, modelInst) {
            callback(err, err ? null : modelInst);
          });
      } else if (actionName === 'destroy') {
        modelInstance.unsetAttribute(propertyName, true);
        // cannot delete property completely the way save works. operator $unset needed like mongo
        modelInstance.save(function(err, modelInst) {
          callback(err, modelInst);
        });
      } else {
        process.nextTick(callback);
      }
    };
    const originalTrigger = inst.trigger;
    inst.trigger = function(actionName, work, data, callback) {
      if (typeof work === 'function') {
        const originalWork = work;
        work = function(next) {
          originalWork.call(this, function(done) {
            inst.triggerParent(actionName, function(err, inst) {
              next(done); // TODO [fabien] - error handling?
            });
          });
        };
      }
      originalTrigger.call(this, actionName, work, data, callback);
    };
  }
};

EmbedsOne.prototype.embeddedValue = function(modelInstance) {
  modelInstance = modelInstance || this.modelInstance;
  const embeddedValue = modelInstance[this.definition.keyFrom];
  this.prepareEmbeddedInstance(embeddedValue);
  return embeddedValue;
};

EmbedsOne.prototype.create = function(targetModelData, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // order.customer.create(data, cb)
    cb = options;
    options = {};
  }
  const modelTo = this.definition.modelTo;
  const propertyName = this.definition.keyFrom;
  const modelInstance = this.modelInstance;

  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }

  targetModelData = targetModelData || {};
  cb = cb || utils.createPromiseCallback();

  const inst = this.callScopeMethod('build', targetModelData);

  const updateEmbedded = function(callback) {
    if (modelInstance.isNewRecord()) {
      modelInstance.setAttribute(propertyName, inst);
      modelInstance.save(options, function(err) {
        callback(err, err ? null : inst);
      });
    } else {
      modelInstance.updateAttribute(propertyName,
        inst, options, function(err) {
          callback(err, err ? null : inst);
        });
    }
  };

  if (this.definition.options.persistent) {
    inst.save(options, function(err) { // will validate
      if (err) return cb(err, inst);
      updateEmbedded(cb);
    });
  } else {
    const context = {
      Model: modelTo,
      instance: inst,
      options: options || {},
      hookState: {},
    };
    modelTo.notifyObserversOf('before save', context, function(err) {
      if (err) {
        return process.nextTick(function() {
          cb(err);
        });
      }

      err = inst.isValid() ? null : new ValidationError(inst);
      if (err) {
        process.nextTick(function() {
          cb(err);
        });
      } else {
        updateEmbedded(function(err, inst) {
          if (err) return cb(err);
          context.instance = inst;
          modelTo.notifyObserversOf('after save', context, function(err) {
            cb(err, err ? null : inst);
          });
        });
      }
    });
  }
  return cb.promise;
};

EmbedsOne.prototype.build = function(targetModelData) {
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;
  const propertyName = this.definition.keyFrom;
  const forceId = this.definition.options.forceId;
  const persistent = this.definition.options.persistent;
  const connector = modelTo.dataSource.connector;

  targetModelData = targetModelData || {};

  this.definition.applyProperties(modelInstance, targetModelData);

  const pk = this.definition.keyTo;
  const pkProp = modelTo.definition.properties[pk];

  let assignId = (forceId || targetModelData[pk] === undefined);
  assignId = assignId && !persistent && (pkProp && pkProp.generated);

  if (assignId && typeof connector.generateId === 'function') {
    const id = connector.generateId(modelTo.modelName, targetModelData, pk);
    targetModelData[pk] = id;
  }

  const embeddedInstance = new modelTo(targetModelData);
  modelInstance[propertyName] = embeddedInstance;

  this.prepareEmbeddedInstance(embeddedInstance);

  return embeddedInstance;
};

EmbedsOne.prototype.update = function(targetModelData, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // order.customer.update(data, cb)
    cb = options;
    options = {};
  }

  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;
  const propertyName = this.definition.keyFrom;

  const isInst = targetModelData instanceof ModelBaseClass;
  const data = isInst ? targetModelData.toObject() : targetModelData;

  const embeddedInstance = this.embeddedValue();
  if (embeddedInstance instanceof modelTo) {
    cb = cb || utils.createPromiseCallback();
    const hookState = {};
    let context = {
      Model: modelTo,
      currentInstance: embeddedInstance,
      data: data,
      options: options || {},
      hookState: hookState,
    };
    modelTo.notifyObserversOf('before save', context, function(err) {
      if (err) return cb(err);

      embeddedInstance.setAttributes(context.data);

      // TODO support async validations
      if (!embeddedInstance.isValid()) {
        return cb(new ValidationError(embeddedInstance));
      }

      modelInstance.save(function(err, inst) {
        if (err) return cb(err);

        context = {
          Model: modelTo,
          instance: inst ? inst[propertyName] : embeddedInstance,
          options: options || {},
          hookState: hookState,
        };
        modelTo.notifyObserversOf('after save', context, function(err) {
          cb(err, context.instance);
        });
      });
    });
  } else if (!embeddedInstance && cb) {
    return this.callScopeMethod('create', data, cb);
  } else if (!embeddedInstance) {
    return this.callScopeMethod('build', data);
  }
  return cb.promise;
};

EmbedsOne.prototype.destroy = function(options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // order.customer.destroy(cb)
    cb = options;
    options = {};
  }
  cb = cb || utils.createPromiseCallback();
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;
  const propertyName = this.definition.keyFrom;
  const embeddedInstance = modelInstance[propertyName];

  if (!embeddedInstance) {
    cb();
    return cb.promise;
  }

  modelInstance.unsetAttribute(propertyName, true);

  const context = {
    Model: modelTo,
    instance: embeddedInstance,
    options: options || {},
    hookState: {},
  };
  modelTo.notifyObserversOf('before delete', context, function(err) {
    if (err) return cb(err);
    modelInstance.save(function(err, result) {
      if (err) return cb(err);
      modelTo.notifyObserversOf('after delete', context, cb);
    });
  });

  return cb.promise;
};

RelationDefinition.embedsMany = function embedsMany(modelFrom, modelToRef, params) {
  params = params || {};
  normalizeRelationAs(params, modelToRef);
  const modelTo = lookupModelTo(modelFrom, modelToRef, params, true);

  const thisClassName = modelFrom.modelName;
  const relationName = params.as || (i8n.camelize(modelTo.modelName, true) + 'List');
  let propertyName = params.property || i8n.camelize(modelTo.pluralModelName, true);
  const idName = modelTo.dataSource.idName(modelTo.modelName) || 'id';

  if (relationName === propertyName) {
    propertyName = '_' + propertyName;
    debug('EmbedsMany property cannot be equal to relation name: ' +
      'forcing property %s for relation %s', propertyName, relationName);
  }

  const definition = modelFrom.relations[relationName] = new RelationDefinition({
    name: relationName,
    type: RelationTypes.embedsMany,
    modelFrom: modelFrom,
    keyFrom: propertyName,
    keyTo: idName,
    modelTo: modelTo,
    multiple: true,
    properties: params.properties,
    scope: params.scope,
    options: params.options,
    embed: true,
  });

  const opts = Object.assign(
    params.options && params.options.property ? params.options.property : {},
    params.options && params.options.omitDefaultEmbeddedItem ? {type: [modelTo]} :
      {
        type: [modelTo],
        default: function() { return []; },
      },
  );

  modelFrom.dataSource.defineProperty(modelFrom.modelName, propertyName, opts);

  if (typeof modelTo.dataSource.connector.generateId !== 'function') {
    modelFrom.validate(propertyName, function(err) {
      const self = this;
      const embeddedList = this[propertyName] || [];
      let hasErrors = false;
      embeddedList.forEach(function(item, idx) {
        if (item instanceof modelTo && item[idName] == undefined) {
          hasErrors = true;
          let msg = 'contains invalid item at index `' + idx + '`:';
          msg += ' `' + idName + '` is blank';
          self.errors.add(propertyName, msg, 'invalid');
        }
      });
      if (hasErrors) err(false);
    });
  }

  if (!params.polymorphic) {
    modelFrom.validate(propertyName, function(err) {
      const embeddedList = this[propertyName] || [];
      const ids = embeddedList.map(function(m) { return m[idName] && m[idName].toString(); }); // mongodb
      if (idsHaveDuplicates(ids)) {
        this.errors.add(propertyName, 'contains duplicate `' + idName + '`', 'uniqueness');
        err(false);
      }
    }, {code: 'uniqueness'});
  }

  // validate all embedded items
  if (definition.options.validate !== false) {
    modelFrom.validate(propertyName, function(err) {
      const self = this;
      const embeddedList = this[propertyName] || [];
      let hasErrors = false;
      embeddedList.forEach(function(item, idx) {
        if (item instanceof modelTo) {
          if (!item.isValid()) {
            hasErrors = true;
            const id = item[idName];
            const first = Object.keys(item.errors)[0];
            let msg = id ?
              'contains invalid item: `' + id + '`' :
              'contains invalid item at index `' + idx + '`';
            msg += ' (`' + first + '` ' + item.errors[first] + ')';
            self.errors.add(propertyName, msg, 'invalid');
          }
        } else {
          hasErrors = true;
          self.errors.add(propertyName, 'contains invalid item', 'invalid');
        }
      });
      if (hasErrors) err(false);
    });
  }

  const scopeMethods = {
    findById: scopeMethod(definition, 'findById'),
    destroy: scopeMethod(definition, 'destroyById'),
    updateById: scopeMethod(definition, 'updateById'),
    exists: scopeMethod(definition, 'exists'),
    add: scopeMethod(definition, 'add'),
    remove: scopeMethod(definition, 'remove'),
    get: scopeMethod(definition, 'get'),
    set: scopeMethod(definition, 'set'),
    unset: scopeMethod(definition, 'unset'),
    at: scopeMethod(definition, 'at'),
    value: scopeMethod(definition, 'embeddedValue'),
  };

  const findByIdFunc = scopeMethods.findById;
  modelFrom.prototype['__findById__' + relationName] = findByIdFunc;

  const destroyByIdFunc = scopeMethods.destroy;
  modelFrom.prototype['__destroyById__' + relationName] = destroyByIdFunc;

  const updateByIdFunc = scopeMethods.updateById;
  modelFrom.prototype['__updateById__' + relationName] = updateByIdFunc;

  const addFunc = scopeMethods.add;
  modelFrom.prototype['__link__' + relationName] = addFunc;

  const removeFunc = scopeMethods.remove;
  modelFrom.prototype['__unlink__' + relationName] = removeFunc;

  scopeMethods.create = scopeMethod(definition, 'create');
  scopeMethods.build = scopeMethod(definition, 'build');

  scopeMethods.related = scopeMethod(definition, 'related'); // bound to definition

  if (!definition.options.persistent) {
    scopeMethods.destroyAll = scopeMethod(definition, 'destroyAll');
  }

  const customMethods = extendScopeMethods(definition, scopeMethods, params.scopeMethods);

  for (let i = 0; i < customMethods.length; i++) {
    const methodName = customMethods[i];
    const method = scopeMethods[methodName];
    if (typeof method === 'function' && method.shared === true) {
      modelFrom.prototype['__' + methodName + '__' + relationName] = method;
    }
  }

  // Mix the property and scoped methods into the prototype class
  const scopeDefinition = defineScope(modelFrom.prototype, modelTo, relationName, function() {
    return {};
  }, scopeMethods, definition.options);

  scopeDefinition.related = scopeMethods.related;

  return definition;
};

EmbedsMany.prototype.prepareEmbeddedInstance = function(inst) {
  if (inst && inst.triggerParent !== 'function') {
    const self = this;
    const propertyName = this.definition.keyFrom;
    const modelInstance = this.modelInstance;
    if (this.definition.options.persistent) {
      const pk = this.definition.keyTo;
      inst.__persisted = !!inst[pk];
    } else {
      inst.__persisted = true;
    }
    inst.triggerParent = function(actionName, callback) {
      if (actionName === 'save' || actionName === 'destroy') {
        const embeddedList = self.embeddedList();
        if (actionName === 'destroy') {
          const index = embeddedList.indexOf(inst);
          if (index > -1) embeddedList.splice(index, 1);
        }
        modelInstance.updateAttribute(propertyName,
          embeddedList, function(err, modelInst) {
            callback(err, err ? null : modelInst);
          });
      } else {
        process.nextTick(callback);
      }
    };
    const originalTrigger = inst.trigger;
    inst.trigger = function(actionName, work, data, callback) {
      if (typeof work === 'function') {
        const originalWork = work;
        work = function(next) {
          originalWork.call(this, function(done) {
            inst.triggerParent(actionName, function(err, inst) {
              next(done); // TODO [fabien] - error handling?
            });
          });
        };
      }
      originalTrigger.call(this, actionName, work, data, callback);
    };
  }
};

EmbedsMany.prototype.embeddedList =
EmbedsMany.prototype.embeddedValue = function(modelInstance) {
  modelInstance = modelInstance || this.modelInstance;
  const embeddedList = modelInstance[this.definition.keyFrom] || [];
  embeddedList.forEach(this.prepareEmbeddedInstance.bind(this));
  return embeddedList;
};

EmbedsMany.prototype.related = function(receiver, scopeParams, condOrRefresh, options, cb) {
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;

  let actualCond = {};

  if (typeof condOrRefresh === 'function' &&
    options === undefined && cb === undefined) {
    // customer.emails(receiver, scopeParams, cb)
    cb = condOrRefresh;
    condOrRefresh = false;
  } else if (typeof options === 'function' && cb === undefined) {
    // customer.emails(receiver, scopeParams, condOrRefresh, cb)
    cb = options;
    options = {};
  }

  if (typeof condOrRefresh === 'object') {
    actualCond = condOrRefresh;
  }

  let embeddedList = this.embeddedList(receiver);

  this.definition.applyScope(receiver, actualCond);

  const params = mergeQuery(actualCond, scopeParams);

  if (params.where && Object.keys(params.where).length > 0) { // TODO [fabien] Support order/sorting
    embeddedList = embeddedList ? embeddedList.filter(applyFilter(params)) : embeddedList;
  }

  const returnRelated = function(list) {
    if (params.include) {
      modelTo.include(list, params.include, options, cb);
    } else {
      process.nextTick(function() { cb(null, list); });
    }
  };

  returnRelated(embeddedList);
};

EmbedsMany.prototype.findById = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // order.emails(fkId, cb)
    cb = options;
    options = {};
  }
  const pk = this.definition.keyTo;
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;

  const embeddedList = this.embeddedList();

  const find = function(id) {
    for (let i = 0; i < embeddedList.length; i++) {
      const item = embeddedList[i];
      if (idEquals(item[pk], id)) return item;
    }
    return null;
  };

  let item = find(fkId.toString()); // in case of explicit id
  item = (item instanceof modelTo) ? item : null;

  if (typeof cb === 'function') {
    process.nextTick(function() {
      cb(null, item);
    });
  }

  return item; // sync
};

EmbedsMany.prototype.exists = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.emails.exists(fkId, cb)
    cb = options;
    options = {};
  }
  const modelTo = this.definition.modelTo;
  const inst = this.findById(fkId, options, function(err, inst) {
    if (cb) cb(err, inst instanceof modelTo);
  });
  return inst instanceof modelTo; // sync
};

EmbedsMany.prototype.updateById = function(fkId, data, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.emails.updateById(fkId, data, cb)
    cb = options;
    options = {};
  }
  if (typeof data === 'function') {
    // customer.emails.updateById(fkId, cb)
    cb = data;
    data = {};
  }
  options = options || {};

  const modelTo = this.definition.modelTo;
  const propertyName = this.definition.keyFrom;
  const modelInstance = this.modelInstance;

  const embeddedList = this.embeddedList();

  const inst = this.findById(fkId);

  if (inst instanceof modelTo) {
    const hookState = {};
    let context = {
      Model: modelTo,
      currentInstance: inst,
      data: data,
      options: options,
      hookState: hookState,
    };
    modelTo.notifyObserversOf('before save', context, function(err) {
      if (err) return cb && cb(err);

      inst.setAttributes(data);

      err = inst.isValid() ? null : new ValidationError(inst);
      if (err && typeof cb === 'function') {
        return process.nextTick(function() {
          cb(err, inst);
        });
      }

      context = {
        Model: modelTo,
        instance: inst,
        options: options,
        hookState: hookState,
      };

      if (typeof cb === 'function') {
        modelInstance.updateAttribute(propertyName, embeddedList, options,
          function(err) {
            if (err) return cb(err, inst);
            modelTo.notifyObserversOf('after save', context, function(err) {
              cb(err, inst);
            });
          });
      } else {
        modelTo.notifyObserversOf('after save', context, function(err) {
          if (!err) return;
          debug('Unhandled error in "after save" hooks: %s', err.stack || err);
        });
      }
    });
  } else if (typeof cb === 'function') {
    process.nextTick(function() {
      cb(null, null); // not found
    });
  }
  return inst; // sync
};

EmbedsMany.prototype.destroyById = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.emails.destroyById(fkId, cb)
    cb = options;
    options = {};
  }
  const modelTo = this.definition.modelTo;
  const propertyName = this.definition.keyFrom;
  const modelInstance = this.modelInstance;

  const embeddedList = this.embeddedList();

  const inst = (fkId instanceof modelTo) ? fkId : this.findById(fkId);

  if (inst instanceof modelTo) {
    const context = {
      Model: modelTo,
      instance: inst,
      options: options || {},
      hookState: {},
    };
    modelTo.notifyObserversOf('before delete', context, function(err) {
      if (err) return cb(err);

      const index = embeddedList.indexOf(inst);
      if (index > -1) embeddedList.splice(index, 1);
      if (typeof cb !== 'function') return;
      modelInstance.updateAttribute(propertyName,
        embeddedList, context.options, function(err) {
          if (err) return cb(err);
          modelTo.notifyObserversOf('after delete', context, function(err) {
            cb(err);
          });
        });
    });
  } else if (typeof cb === 'function') {
    process.nextTick(cb); // not found
  }
  return inst; // sync
};

EmbedsMany.prototype.destroyAll = function(where, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.emails.destroyAll(where, cb);
    cb = options;
    options = {};
  } else if (typeof where === 'function' &&
    options === undefined && cb === undefined) {
    // customer.emails.destroyAll(cb);
    cb = where;
    where = {};
  }
  const propertyName = this.definition.keyFrom;
  const modelInstance = this.modelInstance;

  let embeddedList = this.embeddedList();

  if (where && Object.keys(where).length > 0) {
    const filter = applyFilter({where: where});
    const reject = function(v) { return !filter(v); };
    embeddedList = embeddedList ? embeddedList.filter(reject) : embeddedList;
  } else {
    embeddedList = [];
  }

  if (typeof cb === 'function') {
    modelInstance.updateAttribute(propertyName,
      embeddedList, options || {}, function(err) {
        cb(err);
      });
  } else {
    modelInstance.setAttribute(propertyName, embeddedList, options || {});
  }
};

EmbedsMany.prototype.get = EmbedsMany.prototype.findById;
EmbedsMany.prototype.set = EmbedsMany.prototype.updateById;
EmbedsMany.prototype.unset = EmbedsMany.prototype.destroyById;

EmbedsMany.prototype.at = function(index, cb) {
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;

  const embeddedList = this.embeddedList();

  let item = embeddedList[parseInt(index)];
  item = (item instanceof modelTo) ? item : null;

  if (typeof cb === 'function') {
    process.nextTick(function() {
      cb(null, item);
    });
  }

  return item; // sync
};

EmbedsMany.prototype.create = function(targetModelData, options, cb) {
  const pk = this.definition.keyTo;
  const modelTo = this.definition.modelTo;
  const propertyName = this.definition.keyFrom;
  const modelInstance = this.modelInstance;

  if (typeof options === 'function' && cb === undefined) {
    // customer.emails.create(cb)
    cb = options;
    options = {};
  }

  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }
  targetModelData = targetModelData || {};
  cb = cb || utils.createPromiseCallback();

  const inst = this.callScopeMethod('build', targetModelData);
  const embeddedList = this.embeddedList();

  const updateEmbedded = function(callback) {
    if (modelInstance.isNewRecord()) {
      modelInstance.setAttribute(propertyName, embeddedList);
      modelInstance.save(options, function(err) {
        callback(err, err ? null : inst);
      });
    } else {
      modelInstance.updateAttribute(propertyName,
        embeddedList, options, function(err) {
          callback(err, err ? null : inst);
        });
    }
  };

  if (this.definition.options.persistent) {
    inst.save(function(err) { // will validate
      if (err) return cb(err, inst);
      updateEmbedded(cb);
    });
  } else {
    const err = inst.isValid() ? null : new ValidationError(inst);
    if (err) {
      process.nextTick(function() {
        cb(err);
      });
    } else {
      const context = {
        Model: modelTo,
        instance: inst,
        options: options || {},
        hookState: {},
      };
      modelTo.notifyObserversOf('before save', context, function(err) {
        if (err) return cb(err);
        updateEmbedded(function(err, inst) {
          if (err) return cb(err, null);
          modelTo.notifyObserversOf('after save', context, function(err) {
            cb(err, err ? null : inst);
          });
        });
      });
    }
  }
  return cb.promise;
};

EmbedsMany.prototype.build = function(targetModelData) {
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;
  const forceId = this.definition.options.forceId;
  const persistent = this.definition.options.persistent;
  const propertyName = this.definition.keyFrom;
  const connector = modelTo.dataSource.connector;

  const pk = this.definition.keyTo;
  const pkProp = modelTo.definition.properties[pk];
  const pkType = pkProp && pkProp.type;

  const embeddedList = this.embeddedList();

  targetModelData = targetModelData || {};

  let assignId = (forceId || targetModelData[pk] === undefined);
  assignId = assignId && !persistent;

  if (assignId && pkType === Number) {
    const ids = embeddedList.map(function(m) {
      return (typeof m[pk] === 'number' ? m[pk] : 0);
    });
    if (ids.length > 0) {
      targetModelData[pk] = Math.max.apply(null, ids) + 1;
    } else {
      targetModelData[pk] = 1;
    }
  } else if (assignId && typeof connector.generateId === 'function') {
    const id = connector.generateId(modelTo.modelName, targetModelData, pk);
    targetModelData[pk] = id;
  }

  this.definition.applyProperties(modelInstance, targetModelData);

  const inst = new modelTo(targetModelData);

  if (this.definition.options.prepend) {
    embeddedList.unshift(inst);
    modelInstance[propertyName] = embeddedList;
  } else {
    embeddedList.push(inst);
    modelInstance[propertyName] = embeddedList;
  }

  this.prepareEmbeddedInstance(inst);

  return inst;
};

/**
 * Add the target model instance to the 'embedsMany' relation
 * @param {Object|ID} acInst The actual instance or id value
 */
EmbedsMany.prototype.add = function(acInst, data, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.emails.add(acInst, data, cb)
    cb = options;
    options = {};
  } else if (typeof data === 'function' &&
    options === undefined && cb === undefined) {
    // customer.emails.add(acInst, cb)
    cb = data;
    data = {};
  }
  cb = cb || utils.createPromiseCallback();

  const self = this;
  const definition = this.definition;
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;

  const defOpts = definition.options;
  const belongsTo = defOpts.belongsTo && modelTo.relations[defOpts.belongsTo];

  if (!belongsTo) {
    throw new Error('Invalid reference: ' + defOpts.belongsTo || '(none)');
  }

  const fk2 = belongsTo.keyTo;
  const pk2 = belongsTo.modelTo.definition.idName() || 'id';

  const query = {};

  query[fk2] = (acInst instanceof belongsTo.modelTo) ? acInst[pk2] : acInst;

  const filter = {where: query};

  belongsTo.applyScope(modelInstance, filter);

  belongsTo.modelTo.findOne(filter, options, function(err, ref) {
    if (ref instanceof belongsTo.modelTo) {
      const inst = self.build(data || {});
      inst[defOpts.belongsTo](ref);
      modelInstance.save(function(err) {
        cb(err, err ? null : inst);
      });
    } else {
      cb(null, null);
    }
  });
  return cb.promise;
};

/**
 * Remove the target model instance from the 'embedsMany' relation
 * @param {Object|ID) acInst The actual instance or id value
 */
EmbedsMany.prototype.remove = function(acInst, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.emails.remove(acInst, cb)
    cb = options;
    options = {};
  }
  const self = this;
  const definition = this.definition;
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;

  const defOpts = definition.options;
  const belongsTo = defOpts.belongsTo && modelTo.relations[defOpts.belongsTo];

  if (!belongsTo) {
    throw new Error('Invalid reference: ' + defOpts.belongsTo || '(none)');
  }

  const fk2 = belongsTo.keyTo;
  const pk2 = belongsTo.modelTo.definition.idName() || 'id';

  const query = {};

  query[fk2] = (acInst instanceof belongsTo.modelTo) ? acInst[pk2] : acInst;

  const filter = {where: query};

  belongsTo.applyScope(modelInstance, filter);

  cb = cb || utils.createPromiseCallback();

  modelInstance[definition.name](filter, options, function(err, items) {
    if (err) return cb(err);

    items.forEach(function(item) {
      self.unset(item);
    });

    modelInstance.save(options, function(err) {
      cb(err);
    });
  });
  return cb.promise;
};

RelationDefinition.referencesMany = function referencesMany(modelFrom, modelToRef, params) {
  params = params || {};
  normalizeRelationAs(params, modelToRef);
  const modelTo = lookupModelTo(modelFrom, modelToRef, params, true);

  const thisClassName = modelFrom.modelName;
  const relationName = params.as || i8n.camelize(modelTo.pluralModelName, true);
  const fk = params.foreignKey || i8n.camelize(modelTo.modelName + '_ids', true);
  const idName = modelTo.dataSource.idName(modelTo.modelName) || 'id';
  const idType = modelTo.definition.properties[idName].type;

  const definition = modelFrom.relations[relationName] = new RelationDefinition({
    name: relationName,
    type: RelationTypes.referencesMany,
    modelFrom: modelFrom,
    keyFrom: fk,
    keyTo: idName,
    modelTo: modelTo,
    multiple: true,
    properties: params.properties,
    scope: params.scope,
    options: params.options,
  });

  modelFrom.dataSource.defineProperty(modelFrom.modelName, fk, {
    type: [idType], default: function() { return []; },
  });

  modelFrom.validate(relationName, function(err) {
    const ids = this[fk] || [];
    if (idsHaveDuplicates(ids)) {
      const msg = 'contains duplicate `' + modelTo.modelName + '` instance';
      this.errors.add(relationName, msg, 'uniqueness');
      err(false);
    }
  }, {code: 'uniqueness'});

  const scopeMethods = {
    findById: scopeMethod(definition, 'findById'),
    destroy: scopeMethod(definition, 'destroyById'),
    updateById: scopeMethod(definition, 'updateById'),
    exists: scopeMethod(definition, 'exists'),
    add: scopeMethod(definition, 'add'),
    remove: scopeMethod(definition, 'remove'),
    at: scopeMethod(definition, 'at'),
  };

  const findByIdFunc = scopeMethods.findById;
  modelFrom.prototype['__findById__' + relationName] = findByIdFunc;

  const destroyByIdFunc = scopeMethods.destroy;
  modelFrom.prototype['__destroyById__' + relationName] = destroyByIdFunc;

  const updateByIdFunc = scopeMethods.updateById;
  modelFrom.prototype['__updateById__' + relationName] = updateByIdFunc;

  const addFunc = scopeMethods.add;
  modelFrom.prototype['__link__' + relationName] = addFunc;

  const removeFunc = scopeMethods.remove;
  modelFrom.prototype['__unlink__' + relationName] = removeFunc;

  scopeMethods.create = scopeMethod(definition, 'create');
  scopeMethods.build = scopeMethod(definition, 'build');

  scopeMethods.related = scopeMethod(definition, 'related');

  const customMethods = extendScopeMethods(definition, scopeMethods, params.scopeMethods);

  for (let i = 0; i < customMethods.length; i++) {
    const methodName = customMethods[i];
    const method = scopeMethods[methodName];
    if (typeof method === 'function' && method.shared === true) {
      modelFrom.prototype['__' + methodName + '__' + relationName] = method;
    }
  }

  // Mix the property and scoped methods into the prototype class
  const scopeDefinition = defineScope(modelFrom.prototype, modelTo, relationName, function() {
    return {};
  }, scopeMethods, definition.options);

  scopeDefinition.related = scopeMethods.related; // bound to definition

  return definition;
};

ReferencesMany.prototype.related = function(receiver, scopeParams, condOrRefresh, options, cb) {
  const fk = this.definition.keyFrom;
  const modelTo = this.definition.modelTo;
  const relationName = this.definition.name;
  const modelInstance = this.modelInstance;
  const self = receiver;

  let actualCond = {};
  let actualRefresh = false;

  if (typeof condOrRefresh === 'function' &&
    options === undefined && cb === undefined) {
    // customer.orders(receiver, scopeParams, cb)
    cb = condOrRefresh;
    condOrRefresh = undefined;
  } else if (typeof options === 'function' && cb === undefined) {
    // customer.orders(receiver, scopeParams, condOrRefresh, cb)
    cb = options;
    options = {};
    if (typeof condOrRefresh === 'boolean') {
      actualRefresh = condOrRefresh;
      condOrRefresh = {};
    } else {
      actualRefresh = true;
    }
  }
  actualCond = condOrRefresh || {};

  const ids = self[fk] || [];

  this.definition.applyScope(modelInstance, actualCond);

  const params = mergeQuery(actualCond, scopeParams);
  return modelTo.findByIds(ids, params, options, cb);
};

ReferencesMany.prototype.findById = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.orders.findById(fkId, cb)
    cb = options;
    options = {};
  }
  const modelTo = this.definition.modelTo;
  const modelFrom = this.definition.modelFrom;
  const relationName = this.definition.name;
  const modelInstance = this.modelInstance;

  const pk = this.definition.keyTo;
  const fk = this.definition.keyFrom;

  if (typeof fkId === 'object') {
    fkId = fkId.toString(); // mongodb
  }

  const ids = modelInstance[fk] || [];

  const filter = {};

  this.definition.applyScope(modelInstance, filter);

  cb = cb || utils.createPromiseCallback();

  modelTo.findByIds([fkId], filter, options, function(err, instances) {
    if (err) {
      return cb(err);
    }

    const inst = instances[0];
    if (!inst) {
      err = new Error(g.f('No instance with {{id}} %s found for %s', fkId, modelTo.modelName));
      err.statusCode = 404;
      return cb(err);
    }

    // Check if the foreign key is amongst the ids
    if (utils.findIndexOf(ids, inst[pk], idEquals) > -1) {
      cb(null, inst);
    } else {
      err = new Error(g.f('Key mismatch: %s.%s: %s, %s.%s: %s',
        modelFrom.modelName, fk, modelInstance[fk],
        modelTo.modelName, pk, inst[pk]));
      err.statusCode = 400;
      cb(err);
    }
  });
  return cb.promise;
};

ReferencesMany.prototype.exists = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.orders.exists(fkId, cb)
    cb = options;
    options = {};
  }
  const fk = this.definition.keyFrom;
  const ids = this.modelInstance[fk] || [];

  cb = cb || utils.createPromiseCallback();
  process.nextTick(function() { cb(null, utils.findIndexOf(ids, fkId, idEquals) > -1); });
  return cb.promise;
};

ReferencesMany.prototype.updateById = function(fkId, data, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.orders.updateById(fkId, data, cb)
    cb = options;
    options = {};
  } else if (typeof data === 'function' &&
    options === undefined && cb === undefined) {
    // customer.orders.updateById(fkId, cb)
    cb = data;
    data = {};
  }
  cb = cb || utils.createPromiseCallback();

  this.findById(fkId, options, function(err, inst) {
    if (err) return cb(err);
    inst.updateAttributes(data, options, cb);
  });
  return cb.promise;
};

ReferencesMany.prototype.destroyById = function(fkId, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.orders.destroyById(fkId, cb)
    cb = options;
    options = {};
  }
  const self = this;
  cb = cb || utils.createPromiseCallback();
  this.findById(fkId, function(err, inst) {
    if (err) return cb(err);
    self.remove(inst, function(err, ids) {
      inst.destroy(cb);
    });
  });
  return cb.promise;
};

ReferencesMany.prototype.at = function(index, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.orders.at(index, cb)
    cb = options;
    options = {};
  }
  const fk = this.definition.keyFrom;
  const ids = this.modelInstance[fk] || [];
  cb = cb || utils.createPromiseCallback();
  this.findById(ids[index], options, cb);
  return cb.promise;
};

ReferencesMany.prototype.create = function(targetModelData, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.orders.create(data, cb)
    cb = options;
    options = {};
  }
  const definition = this.definition;
  const modelTo = this.definition.modelTo;
  const relationName = this.definition.name;
  const modelInstance = this.modelInstance;

  const pk = this.definition.keyTo;
  const fk = this.definition.keyFrom;

  if (typeof targetModelData === 'function' && !cb) {
    cb = targetModelData;
    targetModelData = {};
  }
  targetModelData = targetModelData || {};
  cb = cb || utils.createPromiseCallback();

  const ids = modelInstance[fk] || [];

  const inst = this.callScopeMethod('build', targetModelData);

  inst.save(options, function(err, inst) {
    if (err) return cb(err, inst);

    let id = inst[pk];

    if (typeof id === 'object') {
      id = id.toString(); // mongodb
    }

    if (definition.options.prepend) {
      ids.unshift(id);
    } else {
      ids.push(id);
    }

    modelInstance.updateAttribute(fk,
      ids, options, function(err, modelInst) {
        cb(err, inst);
      });
  });
  return cb.promise;
};

ReferencesMany.prototype.build = function(targetModelData) {
  const modelTo = this.definition.modelTo;
  targetModelData = targetModelData || {};

  this.definition.applyProperties(this.modelInstance, targetModelData);

  return new modelTo(targetModelData);
};

/**
 * Add the target model instance to the 'embedsMany' relation
 * @param {Object|ID} acInst The actual instance or id value
 */
ReferencesMany.prototype.add = function(acInst, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.orders.add(acInst, cb)
    cb = options;
    options = {};
  }
  const self = this;
  const definition = this.definition;
  const modelTo = this.definition.modelTo;
  const modelInstance = this.modelInstance;

  const pk = this.definition.keyTo;
  const fk = this.definition.keyFrom;

  const insert = function(inst, done) {
    let id = inst[pk];

    if (typeof id === 'object') {
      id = id.toString(); // mongodb
    }

    const ids = modelInstance[fk] || [];

    if (definition.options.prepend) {
      ids.unshift(id);
    } else {
      ids.push(id);
    }

    modelInstance.updateAttribute(fk, ids, options, function(err) {
      done(err, err ? null : inst);
    });
  };

  cb = cb || utils.createPromiseCallback();

  if (acInst instanceof modelTo) {
    insert(acInst, cb);
  } else {
    const filter = {where: {}};
    filter.where[pk] = acInst;

    definition.applyScope(modelInstance, filter);

    modelTo.findOne(filter, options, function(err, inst) {
      if (err || !inst) return cb(err, null);
      insert(inst, cb);
    });
  }
  return cb.promise;
};

/**
 * Remove the target model instance from the 'embedsMany' relation
 * @param {Object|ID) acInst The actual instance or id value
 */
ReferencesMany.prototype.remove = function(acInst, options, cb) {
  if (typeof options === 'function' && cb === undefined) {
    // customer.orders.remove(acInst, cb)
    cb = options;
    options = {};
  }
  const definition = this.definition;
  const modelInstance = this.modelInstance;

  const pk = this.definition.keyTo;
  const fk = this.definition.keyFrom;

  const ids = modelInstance[fk] || [];

  const id = (acInst instanceof definition.modelTo) ? acInst[pk] : acInst;

  cb = cb || utils.createPromiseCallback();

  const index = utils.findIndexOf(ids, id, idEquals);
  if (index > -1) {
    ids.splice(index, 1);
    modelInstance.updateAttribute(fk, ids, options, function(err, inst) {
      cb(err, inst[fk] || []);
    });
  } else {
    process.nextTick(function() { cb(null, ids); });
  }
  return cb.promise;
};
