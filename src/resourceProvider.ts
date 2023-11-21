import * as _ from 'lodash';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import {
  CountryServiceDefinition as country
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/country';
import {
  OrganizationServiceDefinition as organization
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/organization';
import {
  ContactPointServiceDefinition as contact_point
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/contact_point';
import {
  LocationServiceDefinition as location
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/location';
import {
  AddressServiceDefinition as address
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/address';
import {
  AccessControlServiceDefinition as access_control
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/access_control';
import {
  GraphServiceDefinition as graph
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/graph';
import {
  RoleServiceDefinition as role
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/role';
import {
  FilterOp, Filter_Operation, Filter_ValueType
} from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/resource_base';

const ServiceDefinitions: any = [country, organization, contact_point, location, address, access_control, graph, role];

export class ResourceProvider {
  resourceClients: Map<string, any>;
  clientCfg: any;
  logger: any;

  constructor(clientCfg: any, logger: any) {
    this.resourceClients = new Map<string, any>();
    this.clientCfg = clientCfg;
    this.logger = logger;
  }

  async setup(): Promise<void> {
    this.logger.info('Setting up gRPC resource clients');
    for (let resourceName in this.clientCfg) {
      try {
        const resourceServiceDefinition = ServiceDefinitions.filter((obj) => obj.fullName.split('.')[2] === resourceName);
        const channel = createChannel(this.clientCfg[resourceName].address);
        const client = createClient({ ...this.clientCfg[resourceName], logger: this.logger }, resourceServiceDefinition[0], channel);
        this.resourceClients.set(resourceName, client);
        this.logger.verbose('Created client for resource', { resourceName });
      } catch (error) {
        this.logger.error(`Error creating client instance for resource ${resourceName}`, { code: error.code, message: error.message, stack: error.stack });
      }
    }
  }

  async getResources(entity: string, value: any): Promise<Array<any>> {
    let filters: FilterOp;
    if (_.isArray(value)) {
      filters = {
        filters: [{
          field: 'id',
          operation: Filter_Operation.in,
          value: JSON.stringify(value),
          type: Filter_ValueType.ARRAY,
          filters: []
        }]
      };
    } else {
      filters = {
        filters: [{
          field: 'id',
          operation: Filter_Operation.eq,
          value,
          filters: []
        }]
      };
    }
    const client = this.resourceClients.get(entity);
    if (!client) {
      this.logger.error('No client was found for retrieving resources of type',
        { entity });
    }

    const result = await client.read(filters);
    if (!result?.operation_status || result?.operation_status?.code != 200) {
      this.logger.error('Error while resolving resource relation', {
        code: result.operation_status.code,
        message: result.operation_status.message
      });
      return [];
    }

    let items = [];
    if (result?.data?.items) {
      items = result.data.items;
    }

    if (_.isArray(entity)) {
      return items;
    } else {
      return items.length > 0 ? items[0] : {};
    }
  }
}
