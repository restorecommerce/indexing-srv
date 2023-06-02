import * as _ from 'lodash';
import * as kafka from 'kafka-node';
import * as async from 'async';
import {CommandInterface, Server} from '@restorecommerce/chassis-srv';
import {Events} from '@restorecommerce/kafka-client';
import {IndexingService} from './service';
import {InvalidArgument} from '@restorecommerce/chassis-srv/lib/microservice/errors';
import {createClient} from 'redis';

export class IndexingCommandInterface extends CommandInterface {
  indexer: IndexingService;

  constructor(server: Server, cfg: any, logger: any, events: Events,
    indexer: IndexingService, redisClient: RedisClient) {
    super(server, cfg, logger, events, redisClient);
    this.indexer = indexer;
  }

  async restore({data}: { data: RestoreData[] }): Promise<any> {
    const kafkaCfg = this.config.events.kafka;
    const topicsCfg = kafkaCfg.topics;
    for (let restoreData of data) {
      if (!restoreData.entity.endsWith('_index')) {
        this.logger.warn(
          `Entity ${restoreData.entity} is not indexed; ignoring restore data...`);
        continue;
      }
      restoreData.ignore_offset =
        (restoreData.ignore_offset || []).filter((offset) => {
          const isNumber = !isNaN(offset);
          if (!isNumber) {
            this.logger.warn(`Invalid offset value ${offset} for "ignore_offset" parameter
          on  ${restoreData.entity} restore; discarding value.`);
          }
          return isNumber;
        });

      const baseOffset = Number(restoreData.base_offset) || 0;
      const ignoreOffsets = restoreData.ignore_offset;
      const entity = restoreData.entity.split('_index')[0];

      if (!this.indexer.hasIndex(entity)) {
        throw new InvalidArgument(`Invalid index ${entity}`);
      }

      const topicCfg = topicsCfg[`${entity}s.resource`];
      const topic = await this.kafkaEvents.topic(topicCfg.topic);
      const targetOffset = await topic.$offset(-1);

      const previousListeners = {};
      for (let event of topicCfg.events) {
        previousListeners[event] = topic.emitter.listeners(event);
        await topic.removeAllListeners(event);
      }

      const consumerClient = new kafka.KafkaClient(
        {kafkaHost: kafkaCfg.kafkaHost});
      const consumer = new kafka.Consumer(
        consumerClient,
        [
          {topic: topic.name, offset: baseOffset}
        ],
        {
          autoCommit: true,
          encoding: 'buffer',
          fromOffset: true
        }
      );

      const eventNames = [`${entity}Created`, `${entity}Modified`,
        `${entity}Deleted`];
      const that = this;
      const asyncQueue = async.queue(
        async (message: kafka.Message, done: Function) => {
          const eventName = message.key.toString();
          const content = topic.provider.decodeObject(kafkaCfg, eventName,
            message.value);

          switch (eventName) {
            case `${entity}Created`:
              await that.indexer.update(entity, content, 'create');
              break;
            case `${entity}Modified`:
              await that.indexer.update(entity, content, 'modify');
              break;
            case `${entity}Deleted`:
              await that.indexer.delete(entity, content.id);
              break;
          }

          done();
        });

      asyncQueue.drain = () => {
        // commit state first, before resuming
        this.logger.verbose('Committing offsets upon async queue drain');
        return new Promise((resolve, reject) => {
          consumer.commit((err, data) => {
            if (err) {
              return reject(err);
            }
            resolve(data);
          });
        }).then(() => {
        }).catch((err) => {
          this.logger.error('Error catched while comitting offsets on restore');
        });
      };

      consumer.on('message', async (message: kafka.Message): Promise<void> => {
        const eventName = message.key.toString();
        if (_.includes(eventNames, eventName) &&
          !_.includes(ignoreOffsets, message.offset)) {
          asyncQueue.push(message);
        }

        if (message.offset >= targetOffset) {
          await new Promise((resolve, reject) => {
            consumer.removeTopics([topic.name], (err, removed) => {
              if (err) {
                reject(err);
              }
              consumer.close((err) => {
                if (err) {
                  reject(err);
                }
                resolve(undefined);
              });
            });
          });

          const msg = {
            topic: topic.name,
            offset: message.offset
          };
          await that.commandTopic.emit('restoreResponse', {
            services: _.keys(that.service),
            payload: that.encodeMsg(msg)
          });
        }
      });
    }
    return {};
  }

  async reset(): Promise<any> {
    await this.indexer.deleteAllData();
    await this.commandTopic.emit('restoreResponse', {
      services: _.keys(this.service),
      payload: this.encodeMsg({
        status: 'Reset concluded successfully'
      })
    });
    return {};
  }
}

export interface RestoreData {
  entity: string;
  base_offset?: number;
  ignore_offset?: number[];
}
