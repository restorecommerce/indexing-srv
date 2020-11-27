import * as _ from 'lodash';
import {Client, toStruct} from '@restorecommerce/grpc-client';

export class ResourceProvider {
  resourceClients: Map<string, any>;
  clientCfg: any;
  logger: any;

  constructor(clientCfg: any, logger: any) {
    this.resourceClients = new Map<string, Client>();
    this.clientCfg = clientCfg;
    this.logger = logger;
  }

  async setup(): Promise<void> {
    const serviceCfg = this.clientCfg.services;
    const defaultConfig = this.clientCfg['default-resource-srv'];

    this.logger.info('Setting up gRPC resource clients');

    for (let serviceName in serviceCfg) {
      let config: any;
      if (serviceName == 'default') {
        for (let resourceName in serviceCfg[serviceName]) {
          // default config for fetching resources from resource-srv
          config = _.cloneDeep(defaultConfig);
          const resourceClientCfg = serviceCfg[serviceName][resourceName];
          //  resource-specific configs
          config.transports.grpc.protos = resourceClientCfg.protos; // proto file
          config.transports.grpc.service = resourceClientCfg.serviceName; // proto file service name
          const client = new Client(config, this.logger);
          const service = await client.connect();
          this.resourceClients.set(resourceName, service);
          this.logger.verbose('Created client for resource', {resourceName});
        }
      } else if (serviceName != 'indexing-srv') {
        config = serviceCfg[serviceName];
        const client = new Client(config, this.logger);
        const service = await client.connect();
        this.resourceClients.set(serviceName, service);
        this.logger.verbose('Created client for resource', {serviceName});
      }
    }
  }

  async getResources(entity: string, value: any): Promise<Array<any>> {
    // TODO: make it possible to query for other fields besides the ID
    let filter: any;
    if (_.isArray(value)) {
      filter = {
        id: {
          $in: value
        }
      };
    } else {
      filter = {
        id: {
          $eq: value
        }
      };
    }
    const client = this.resourceClients.get(entity);
    if (!client) {
      this.logger.error('No client was found for retrieving resources of type',
        {entity});
    }

    const result = await client.read({filter: toStruct(filter)});
    if (result.error) {
      this.logger.error('Error while resolving resource relation', {
        error: result.error.name,
        stack: result.error.stack
      });
      return [];
    }

    let items = [];
    if (result.data && result.data.items) {
      items = result.data.items;
    }

    if (_.isArray(entity)) {
      return items;
    } else {
      return items.length > 0 ? items[0] : {};
    }
  }
}
