import * as _ from 'lodash';
import * as elasticsearch from '@elastic/elasticsearch';
import * as jsonfile from 'jsonfile';
import traverse from 'traverse';
import { errors } from '@restorecommerce/chassis-srv';
import { ResourceProvider } from './resourceProvider';
import {
  createActionTarget, createResourceTarget, getSubTreeOrgs
} from './utils';
import { Logger } from 'winston';
import { SearchRequest, DeepPartial, SearchResponse } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/search';
const bodybuilder = require('bodybuilder');

export class InvalidResourceError extends Error {
}

export class IndexingService {
  client: elasticsearch.Client;
  mappings: Map<string, MappingSettings>;
  mappingsDir: string;
  relationsConfigs: Map<string, Relation[]>;
  searchableFields: Map<string, string[]>;
  nestedArrayHandlers: Map<string, any[]>;
  resourceProvider: ResourceProvider;
  cfg: any;
  logger: Logger;

  constructor(cfg: any, logger: Logger, mappingsDir: string) {
    // this.cfg = cfg.get('elasticsearch');
    this.cfg = cfg;
    this.logger = logger;
    const esConfig = cfg.get('elasticsearch');
    this.client = new elasticsearch.Client(esConfig.client);
    this.mappings = new Map<string, MappingSettings>();
    this.relationsConfigs = new Map<string, Relation[]>();
    this.searchableFields = new Map<string, string[]>(); // maps an index to its fields for cross-field search
    this.nestedArrayHandlers = new Map<string, any[]>();

    this.mappingsDir = mappingsDir || './cfg';

    const clientCfg = cfg.get('client');
    if (clientCfg) {
      this.resourceProvider = new ResourceProvider(cfg.get('client'), logger);
    }
  }

  async connect(): Promise<void> {
    const indices = this.cfg.get('elasticsearch:indices'); // list of index names
    this.logger.verbose('Loading ElasticSearch indexes', indices);
    for (let index of indices) {
      await this.ensureMapping(index);
    }
    await this.resourceProvider.setup();
  }

  hasIndex(index: string): boolean {
    return this.mappings.has(index);
  }

  async search(request: SearchRequest, context: any): Promise<DeepPartial<SearchResponse>> {
    if (!this.mappings.has(request.collection)) {
      throw new errors.Unimplemented(
        `Fulltext search is not configured for entity ${request.collection}`);
    }
    const body = this.makeFulltextSearchBody(request.collection, request.text,
      request.acls);
    let result;
    try {
      result = await this.client.search({
        index: request.collection,
        body
      });
      this.logger.debug('Fulltext search response', result);
    } catch (error) {
      this.logger.error('Error occured querying ES', { code: error.code, message: error.message, stack: error.stack });
      throw (error);
    }
    if (_.isEmpty(result.hits) || result.hits.total.value == 0) {
      return {};
    }

    const hits = result.hits.hits;

    return {
      data: hits.map((hit) => {
        const source = hit._source;
        delete source.settings;

        return {
          type_url: 'io.restorecommerce.search',
          value: Buffer.from(
            JSON.stringify(Object.assign({ id: hit._id }, hit._source)))
        } as DeepPartial<SearchResponse>;
      })
    };
  }


  makeFulltextSearchBody(index: string, text: string, acl: string[]): any {
    const searchLimit = this.cfg.get('elasticsearch:searchLimit');
    if (acl && acl.length > 0) {
      return bodybuilder().size(searchLimit)
        .query('nested', { path: 'meta' }, q => {
          for (let value of acl) {
            q = q.orQuery('term', 'meta.acl', value);
          }
          return q;
        })
        .andQuery('multi_match', {
          query: text,
          fields: this.searchableFields.get(index),
          lenient: true
        })
        .build();
    } else {
      return bodybuilder().size(searchLimit)
        .query('multi_match', {
          query: text,
          fields: this.searchableFields.get(index),
          lenient: true
        })
        .build();
    }
  }

  async update(resourceName: string, resourceData: any,
    eventName: UpdateAction, test?: boolean): Promise<void> {
    if (_.isEmpty(resourceData.id)) {
      throw new InvalidResourceError('ID property is required on a resource');
    }
    // Make whatIsAllowed() request and get the list of policies for the resource
    // and hence the roles for the user retrieving set of applicable policies/rules from ACS
    // Note: it is assumed that there is only one policy set
    const acsRequest: any = {
      target: {
        action: createActionTarget('read', this.cfg)
      },
    };

    acsRequest.target.resources =
      createResourceTarget([resourceName], 'read', this.cfg);
    let policySet;
    try {
      const acsService = this.resourceProvider.resourceClients.get('acs-srv');
      if (!test) {
        policySet = await acsService.whatIsAllowed(acsRequest);
      }
    } catch (err) {
      this.logger.error(
        `Resource ${resourceName} could not be indexed due to error:`,
        { error: err.message });
      return;
    }

    if (!test) {
      if (!policySet || (policySet.data.policy_sets.size == 0)) {
        this.logger.error(`Resource ${resourceName} could not be indexed since
        there was no policy associated with it.`);
        return;
      }
      if (!_.isEmpty(policySet.error)) {
        this.logger.error(`Resource ${resourceName} could not be indexed due to
        error retreiving polices:`, { error: policySet.error });
        return;
      }
    }

    // a) First get a list of RoleIds which have a scoping entity for this resource based on the list of Rules
    // b) Get the list of SubOrgs based on OwnerID if the scoping entity is Organization
    // c) multiply a and b to create a String array of ACL, which is then
    // later added to resourcData inside meta (use acl as keyword for this string array)

    let roleIDs = new Set<String>();
    let orgIds = new Set<String>();
    let urnsCfg = this.cfg.get('authorization:urns');

    if (policySet && policySet.data && policySet.data.policy_sets &&
      policySet.data.policy_sets[0]
      && policySet.data.policy_sets[0].policies) {
      // Iterate through all the policies
      // Note: it is assumed that there is only one policy set
      const policies = policySet.data.policy_sets[0].policies;
      for (let policy of policies) {
        // get list of rules
        const rules = policy.rules;
        // get Rule's target->subject roleID (only if it contains a role scoping Entity)
        for (let rule of rules) {
          if (rule?.target?.subjects) {
            const ruleSub = rule.target.subjects;
            let foundRole = false;
            let roleID;
            for (let subAttribute of ruleSub) {
              if (subAttribute.id === urnsCfg.role) {
                roleID = subAttribute.value;
                foundRole = true;
              }
              if (subAttribute.id === urnsCfg.roleScopingEntity && foundRole) {
                if (roleID) {
                  roleIDs.add(roleID);
                }
                foundRole = false;
                roleID = undefined;
              }
            }
          }
        }
      }
    }

    if (resourceData?.meta?.owners?.length > 0) {
      for (let attributes of resourceData.meta.owners) {
        if (attributes.id === urnsCfg.ownerEntity
          && attributes.value === urnsCfg.ownerOrg && attributes.attributes.length > 0) {
          for (let attributeObj of attributes.attributes) {
            if (attributeObj.id === urnsCfg.ownerInstance) {
              orgIds.add(attributeObj.value);
            }
          }
        }

      }
    }

    let completeOrgHierarchy = new Set<String>();
    for (let orgID of Array.from(orgIds)) {
      const orgList = await getSubTreeOrgs(orgID, 'outbound',
        this.resourceProvider.resourceClients.get('graph-srv'), this.cfg,
        this.logger);
      completeOrgHierarchy =
        new Set<String>([...Array.from(completeOrgHierarchy), ...Array.from(orgList)]);
    }

    let aclList = [];
    if (roleIDs.size > 0 && completeOrgHierarchy.size > 0) {
      for (let roleID of Array.from(roleIDs)) {
        for (let orgID of Array.from(completeOrgHierarchy)) {
          aclList.push(`${roleID}@${orgID}`);
        }
      }
    }

    resourceData.meta.acl = aclList;
    const body = await this.convertDocument(resourceName, resourceData);

    // to handle uint64 for protocolbuffers
    const keys = Object.keys(body);
    const nestedLongHandler = this.cfg.get('nestedArrayLongHandlers');
    for (let key of keys) {
      if (key === nestedLongHandler.root) {
        const longObj = body[key];
        if (longObj[nestedLongHandler.key] > Number.MAX_SAFE_INTEGER) {
          longObj[nestedLongHandler.key] =
            (longObj[nestedLongHandler.key] as Long).toNumber();
        }
      }
      if (body[key] > Number.MAX_SAFE_INTEGER) {
        body[key] = (body[key]).toNumber();
      }
    }

    let result: any;
    const data = {
      index: resourceName,
      id: resourceData.id,
      body
    };

    if (eventName == 'create') {
      // create the document
      try {
        result = await this.client.index(data);
      } catch (err) {
        this.logger.error('Error while indexing ES data', { error: err });
      }
    } else if (eventName == 'modify') {
      // partiallty update the document
      // note: whenever `update` is called,
      // ElasticSearch actually deletes the old document
      // and indexes an updated document
      try {
        data.body = {
          doc: data.body
        };
        result = await this.client.update(data);
      } catch (err) {
        this.logger.error('Error while updating indexed ES data', { error: err });
      }
    }

    if (result.result == 'created') {
      this.logger.debug(
        `Document ${resourceData.id} from resource ${resourceName} was indexed`,
        result.result);
    }
  }

  async delete(resourceName: string, id: string): Promise<void> {
    // delete the document on ES by its ID
    const result = await this.client.delete({
      index: resourceName,
      id
    });

    this.logger.debug(`Document ${id} was deleted`, result);
  }

  async ensureMapping(index: string): Promise<void> {
    let exists = false;
    try {
      exists = await this.client.indices.exists({ index });
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }

    this.logger.verbose(`Loading mapping for index ${index}`);
    const mapping = this.loadMapping(index);

    this.logger.verbose(`Setting mapping fields for index ${index}`);

    if (!mapping.mappings) {
      this.logger.error(`No mapping defined for ${index}`);
      return;
    }

    // setting meta property for all mappings
    mapping.mappings.properties.meta = {
      type: 'nested',
      properties: {
        created: {
          type: 'date',
          format: 'strict_date_optional_time||epoch_millis',
          index: false,
        },
        modified: {
          type: 'date',
          format: 'strict_date_optional_time||epoch_millis',
          index: false,
        },
        modified_by: {
          type: 'keyword',
          index: false,
        },
        owners: {
          type: 'nested',
          properties: {
            id: {
              type: 'keyword',
              index: false,
            },
            value: {
              type: 'keyword',
              index: false,
            }
          }
        },
        acl: {
          type: 'keyword'
        }
      }
    };
    const convertedMapping = this.convertMapping(index, mapping);
    const searchableFields: string[] = _.reduce(convertedMapping.fields,
      (result: string[], value: any, key) => {
        if (!(_.has(value, 'node.index') && _.get(value, 'node.index') ===
          false)) {
          result.push(value.path);
        }
        return result;
      }, []);
    this.mappings.set(index, convertedMapping);
    this.searchableFields.set(index, searchableFields);

    let nestedArrayHandlersCfg = this.cfg.get(`nestedArrayHandlers:${index}`) ||
      [];
    // common config for all resources
    const nestedMetaCfg = {
      root: 'meta.owners',
      objectKeys: ['id', 'value']
    };
    nestedArrayHandlersCfg = nestedArrayHandlersCfg.concat(nestedMetaCfg);
    // Iterate through objectKeys and construct complete path
    for (let key of nestedMetaCfg.objectKeys) {
      if (!nestedMetaCfg['fullPath']) {
        nestedMetaCfg['fullPath'] = [];
      }
      nestedMetaCfg['fullPath'].push(`${nestedMetaCfg.root}.${key}`);
    }
    this.nestedArrayHandlers.set(index, nestedArrayHandlersCfg);

    const relationsConfig = this.cfg.get(`relations:${index}`);
    if (relationsConfig) {
      this.relationsConfigs.set(index, relationsConfig);
    }

    if (exists) {
      this.logger.verbose(
        `Index ${index} already exists; skipping mapping updated`);
      return;
    }

    this.logger.silly(`Creating mapping for index ${index}`);
    const result = await this.client.indices.create({
      index,
      body: mapping
    });

    if (!result.acknowledged) {
      this.logger.error(`Index ${index} was not acknowledged`, result);
      return;
    }

    this.logger.verbose(`Index ${index} mapping was successfully created`);
  }

  loadMapping(index: string): any {
    return jsonfile.readFileSync(`${this.mappingsDir}/${index}.json`);
  }

  convertMapping(index: string, mapping: any, ): MappingSettings {
    return {
      geoPoints: this.getType(index, mapping, 'geo_point'),
      completions: this.getType(index, mapping, 'completion'),
      fields: this.getAllTypes(index, mapping)
    };
  }

  getType(index: string, mapping: any, type: SpecialType): MappingField[] {
    return this.traverseMapping(index, mapping, type);
  }

  getAllTypes(index: string, mapping: any): MappingField[] {
    return this.traverseMapping(index, mapping);
  }

  traverseMapping(index: string, mapping: any,
    type?: SpecialType): MappingField[] {
    return traverse(mapping)
      .reduce(function find(acc: MappingField[], node: any): MappingField[] {
        if (_.isNil(node)) {
          return acc;
        }

        if ((type && node.type == type) || (!type && node.type)) {
          const segments = _.pull(this.path, 'properties', 'mappings', index);
          if (node.type != 'nested') {
            acc.push({
              node,
              path: segments.join('.'),
            });
          }
        }

        return acc;
      }, []);
  }

  async convertDocument(resourceName: string, document: any): Promise<any> {
    if (!this.mappings.has(resourceName)) {
      throw new InvalidResourceError(
        `MappingSettings for resource ${resourceName} was not provided`);
    }

    if (this.relationsConfigs.has(resourceName)) {
      await this.resolveResourceRelations(resourceName, document,
        this.relationsConfigs.get(resourceName));
    }

    const mapping = this.mappings.get(resourceName);

    if (!_.isEmpty(mapping.geoPoints)) {

      for (let i = 0; i < mapping.geoPoints.length; i += 1) {
        const geoPoint = mapping.geoPoints[i];
        const geoPointPath = geoPoint.path;
        const location = _.get(document, geoPointPath);
        if (_.isNil(location)) {
          this.logger.warn(
            `Resource ${resourceName} has no geo_point field in path ${geoPointPath}`);
          continue;
        }

        location.lat = location.latitude;
        location.lon = location.longitude;
        delete location.latitude;
        delete location.longitude;
      }
    }

    if (!_.isEmpty(mapping.completions)) {
      for (let i = 0; i < mapping.completions.length; i++) {
        const completion = mapping.completions[i];
        const path = completion.path;
        const segments = path.split('.');
        const fieldName = _.last(segments);
        // completions are named as `<field>-completion`
        const targetFieldName = _.first(fieldName.split('-'));
        segments[segments.length - 1] = targetFieldName;
        const targetPath = segments.join('.');
        const result = {
          input: _.words(_.get(document, targetPath)),
          output: _.get(document, targetPath),
          payload: {
            id: document.id,
          }
        };
        document.path = result;
      }
    }

    let filtered = {};
    const nestedArrayHandlers = this.nestedArrayHandlers.get(resourceName);
    const customIndexCfg = this.cfg.get('customIndex');
    let customIndex = ((resourceName === customIndexCfg.entity) ? true : false);
    _.forEach(mapping.fields, (field: any) => {
      const path = field.path;
      let nestedObject = false;
      if (customIndex && _.includes(path, customIndexCfg.key)) {
        customIndex = false;
        this.customIndex(document, filtered, customIndexCfg.key);
      }
      // handle nested array doc fields
      if (nestedArrayHandlers.length > 0) { // path here is meta.owners.id
        for (let eachNestedArray of nestedArrayHandlers) {
          if (_.includes(eachNestedArray.fullPath, path)) {
            // Iterate through doc and set the value
            const objKeys = path.split('.');
            const matchingKey = objKeys[objKeys.length - 1];
            let nestedArrayDoc = _.cloneDeep(document);
            const absPath = eachNestedArray.root.split('.');
            for (let eachPath of absPath) {
              // complete owners object
              nestedArrayDoc = nestedArrayDoc[eachPath];
            }

            for (let doc of nestedArrayDoc) {
              if (doc[matchingKey]) {
                let newPath = path;
                for (let i = path.length - 1; i >= 0; i--) {
                  // to get only meta.owner sas new path
                  newPath = newPath.substr(0, newPath.length - 1);
                  if (path[i] == '.') {
                    break;
                  }
                }
                _.set(filtered, newPath, nestedArrayDoc);
                nestedObject = true;
              }
            }
          }
        }
      }
      if (!nestedObject) {
        // Prtobuf spits a long object and below fix is to convert it to number
        // to index it to ES.
        if (field && field.node && field.node.type &&
          field.node.type == 'long') {
          _.set(filtered, path, Number(_.get(document, path)));
        } else {
          _.set(filtered, path, _.get(document, path));
        }
      }
    });

    return filtered;
  }

  customIndex(document: any, filtered: any, key: string): void {
    filtered[key] = document[key];
  }

  async resolveResourceRelations(index: string, document: any,
    relationsCfg: Relation[]): Promise<any> {

    for (let property in document) {
      for (let relation of relationsCfg) {
        let objectKeys = [];
        let nestedPath = false;
        let pathPrefix;
        if (relation.nestedPath) {
          nestedPath = true;
          pathPrefix = relation.nestedPath;
        }
        if (_.isArray(document[property])) {
          for (let eachDoc of document[property]) {
            if (_.isObject(eachDoc)) {
              objectKeys = Object.keys(eachDoc);
            } else {
              objectKeys = [property];
            }
          }
        } else {
          objectKeys = [property];
        }
        for (let eachProperty of objectKeys) {
          if (relation.field == eachProperty) {
            if (nestedPath) {
              eachProperty = pathPrefix;
            }
            let data;
            if (pathPrefix) {
              let docArray = document[pathPrefix];
              for (let i = 0; i < docArray.length; i++) {
                data = await this.resourceProvider.getResources(relation.entity,
                  docArray[i][relation.field]);
                docArray[i][relation.mappingProperty] = data;
              }
            } else {
              data = await this.resourceProvider.getResources(relation.entity,
                document[eachProperty]);
              delete document[eachProperty];
            }
            if (relation.relations) {
              // get the keys and pass the key below
              const nestedRelationFields = Object.keys(relation.relations);
              for (let nestedRelationField of nestedRelationFields) {
                await this.resolveResourceRelations(relation.entity, data,
                  relation.relations[nestedRelationField]);
              }
            }
            document[relation.mappingProperty] = data;
          }
        }
      }
    }
  }

  async deleteAllData(): Promise<void> {
    for (let [index, mapping] of this.mappings) {
      this.logger.verbose(`Deleting all documents from index ${index}`);
      await this.client.deleteByQuery({
        index,
        body: {
          query: { match_all: {} }
        }
      });
    }
  }
}

export interface MappingField {
  node: any;
  path: string; // '.'-separated path
}

export interface MappingSettings {
  completions: MappingField[];
  geoPoints: MappingField[];
  fields: MappingField[];
}

export type SpecialType = 'geo_point' | 'completion' | 'date';
export type UpdateAction = 'create' | 'modify';

export interface Relation {
  field: string;
  mappingProperty: string; // each relation field name is replaced by the mappingProperty
  entity: string;
  relations?: Relation[];
  nestedPath?: string;
}