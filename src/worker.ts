import { Events, registerProtoMeta } from '@restorecommerce/kafka-client';
import {
  CommandInterface, config, Health, OffsetStore, Server
} from '@restorecommerce/chassis-srv';
import { createLogger } from '@restorecommerce/logger';
import { Logger } from 'winston';
import { IndexingService } from './service';
import { IndexingCommandInterface } from './commandInterface';
import { formatResourceType } from './utils';
import { createClient, RedisClientType } from 'redis';
import { protoMetadata as commandInterfaceMeta, CommandInterfaceServiceDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/commandinterface';
import { protoMetadata as healthInterfaceMeta, HealthDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/grpc/health/v1/health';
import { BindConfig } from '@restorecommerce/chassis-srv/lib/microservice/transport/provider/grpc';
import { SearchServiceDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/search';
import { protoMetadata as addressProtoMeta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/address';
import { protoMetadata as organizationProtoMeta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/organization';
import { protoMetadata as contactPointProtoMeta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/contact_point';
import { protoMetadata as userProtoMeta } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/user';

registerProtoMeta(
  commandInterfaceMeta, healthInterfaceMeta, addressProtoMeta,
  organizationProtoMeta, contactPointProtoMeta, userProtoMeta
);

export class Worker {
  cfg: any;
  logger: Logger;
  server: Server; // gRPC
  events: Events; // Kafka
  indexer: IndexingService;
  commandInterface: CommandInterface;
  offsetStore: OffsetStore;
  redisClient: RedisClientType<any, any>;

  async start(cfg?: any, logger?: Logger, mappingsDir?: string): Promise<void> {
    cfg = cfg || await config.get(logger);
    cfg = this.setUpResourcesConfig(cfg);
    this.cfg = cfg;

    logger = logger || createLogger(cfg.get('logger'));
    this.logger = logger;

    const kafkaCfg = cfg.get('events:kafka');
    const events = new Events(kafkaCfg, logger);
    await events.start();

    this.events = events;

    const indexer = new IndexingService(cfg, logger, mappingsDir);
    this.indexer = indexer;
    await indexer.connect();

    const offsetStore = new OffsetStore(events, cfg, logger);
    this.offsetStore = offsetStore;
    // subscribe to topics
    for (let topicLabel in kafkaCfg.topics) {
      const topicCfg = kafkaCfg.topics[topicLabel];
      const topicName = topicCfg.topic;
      const eventNames = topicCfg.events;

      const topic = await events.topic(topicName);
      const offsetValue = await offsetStore.getOffset(topicName);
      for (let event of eventNames) {
        await topic.on(event, this.listener.bind(this),
          { startingOffset: offsetValue });
      }
    }

    const redisConfig = cfg.get('redis');
    redisConfig.db = this.cfg.get('redis:db-indexes:db-subject');
    this.redisClient = createClient(redisConfig);
    this.redisClient.on('error', (err) => logger.error('Redis Client Error', err));
    await this.redisClient.connect();

    const server = new Server(cfg.get('server'), logger);
    this.commandInterface =
      new IndexingCommandInterface(server, cfg, logger, events, indexer,
        this.redisClient);

    await server.bind('io-restorecommerce-indexing-cis', {
      service: CommandInterfaceServiceDefinition,
      implementation: this.commandInterface
    } as BindConfig<CommandInterfaceServiceDefinition>);

    await server.bind('io-restorecommerce-indexing-srv', {
      service: SearchServiceDefinition,
      implementation: indexer
    } as BindConfig<SearchServiceDefinition>);

    await server.bind('grpc-health-v1', {
      service: HealthDefinition,
      implementation: new Health(this.commandInterface)
    } as BindConfig<HealthDefinition>);

    this.server = server;
    await server.start();
    this.logger.info('Server started successfully');
  }

  async stop(): Promise<void> {
    await this.server.stop();
    await this.offsetStore.stop();
    await this.events.stop();
  }

  async listener(msg: any, context: any, config: any,
    eventName: string): Promise<void> {
    if (eventName.endsWith('Created')) {
      const resourceName = eventName.substr(0, eventName.indexOf('Created'));
      // Resource is indexed (same api is used for creating and updating)
      await this.indexer.update(resourceName, msg, 'create');
    } else if (eventName.endsWith('Modified')) {
      const resourceName = eventName.substr(0, eventName.indexOf('Modified'));
      await this.indexer.update(resourceName, msg, 'modify');
    } else if (eventName.endsWith('Deleted')) {
      const resourceName = eventName.substr(0, eventName.indexOf('Deleted'));
      await this.indexer.delete(resourceName, msg.id);
    } else if (eventName.endsWith('Command')) {
      await this.commandInterface.command(msg, context);
    }
  }

  setUpResourcesConfig(cfg: any): any {
    const kafkaCfg = cfg.get('events:kafka');
    const resourcesCfg = cfg.get('resources'); // list of index/resource names

    for (let resourceType in resourcesCfg) {
      const { serviceNamePrefix, resources } = resourcesCfg[resourceType];
      for (let resourceName of resources) {
        const topicCfg = {
          topic: `${serviceNamePrefix}${resourceName}s.resource`,
          events: [
            `${resourceName}Created`,
            `${resourceName}Modified`,
            `${resourceName}Deleted`
          ]
        };

        if (!kafkaCfg.topics) {
          kafkaCfg.topics = {};
        }

        kafkaCfg.topics[`${resourceName}s.resource`] = topicCfg;

        const compResourceName = formatResourceType(resourceName);
        const messageObject = `${serviceNamePrefix}${compResourceName}`;

        ['Created', 'Modified'].forEach((label) => {
          kafkaCfg[`${resourceName}${label}`] = {
            messageObject
          };
        });
        kafkaCfg[`${resourceName}Deleted`] = {
          messageObject: `${serviceNamePrefix}${resourceName}.Deleted`
        };
      }
    }

    cfg.set('events:kafka', kafkaCfg);
    return cfg;
  }
}


if (require.main === module) {
  const app = new Worker();
  app.start().catch((err) => {
    console.error('startup error', err);
    process.exit(1);
  });
  process.on('SIGINT', () => {
    app.stop().catch((err) => {
      console.error('shutdown error', err);
      process.exit(1);
    });
  });
}
