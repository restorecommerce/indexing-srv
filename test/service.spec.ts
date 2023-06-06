import * as should from 'should';
import { config } from '@restorecommerce/chassis-srv';
import { Events, Topic } from '@restorecommerce/kafka-client';
import * as _ from 'lodash';
import * as elasticsearch from '@elastic/elasticsearch';
import * as uuid from 'uuid';
import { Worker } from '../src/worker';
import { createChannel, createClient } from '@restorecommerce/grpc-client';
import { SearchServiceDefinition } from '@restorecommerce/rc-grpc-clients/dist/generated-server/io/restorecommerce/search';
const bodybuilder = require('bodybuilder');

describe('Service tests', () => {
  let cfg: any;
  let service: Worker;
  let events: Events;
  let logger: any;
  let esClient: elasticsearch.Client;
  let topic: Topic;
  let data: any;
  let origClonedData: any;
  let searchService: any;
  let indexer: any;
  before(async function init(): Promise<void> {
    this.timeout(3000);
    cfg = await config.load(process.cwd() + '/test');
    service = new Worker();

    await service.start(cfg, null, process.cwd() + '/test/mappings/');

    events = service.events;
    logger = service.logger;
    indexer = service.indexer;

    topic = await events.topic('io.restorecommerce.organizations.resource');
    const esCfg = _.cloneDeep(cfg.get('elasticsearch:client'));
    esClient = new elasticsearch.Client(esCfg);

    const channel = createChannel(cfg.get('test-client:indexing-srv').address);
    searchService = createClient({
      ...cfg.get('test-client:indexing-srv'),
      logger
    }, SearchServiceDefinition, channel);
  });

  after(async function end(): Promise<void> {
    this.timeout(4000);

    await esClient.deleteByQuery({
      index: 'organization',
      body: { query: { match_all: {} } },
      refresh: true
    });

    await esClient.indices.refresh({ index: 'organization' });

    await service.stop();
  });

  it('should have created a index for each resource at startup',
    async function checkES(): Promise<void> {
      const response = await esClient.indices.exists({
        index: 'organization'
      });
      should.exist(response);
      response.should.equal(true);
    });

  describe('indexing emitted Kafka data', () => {
    it('should index a new document',
      async function consumeEvents(): Promise<void> {
        this.timeout(4000);
        data = makeCreateOrgRequest();
        origClonedData = _.cloneDeep(data);
        await indexer.update('organization', data, 'create', true);

        await esClient.indices.refresh({ index: 'organization' });

        const response = await esClient.search({
          index: 'organization',
          body: makeESQuery()
        });

        should.exist(response);
        should.exist(response.hits);
        should.exist(response.hits.hits);
        (response.hits.total as any).value.should.equal(1);

        const src = response.hits.hits[0]._source;
        const doc = _.pick(src,
          ['name', 'website', 'email', 'address', 'meta']);
        doc['id'] = response.hits.hits[0]._id;
        doc.should.deepEqual(origClonedData);
      });
    // NOTE: updates should only work properly once the Protobuf issue with default null fields is solved
    it('should perform partial updates',
      async function consumeEvents(): Promise<void> {
        const partialData = makeModifyOrgRequest(data);
        const updatedData = _.defaults({}, partialData, origClonedData);
        const compareData = _.cloneDeep(updatedData);
        // await topic.emit('organizationModified', updatedData);
        await indexer.update('organization', updatedData, 'modify', true);

        await esClient.indices.refresh({ index: 'organization' });

        let response;
        for (let i = 0; i < 10; i += 1) {
          response = await esClient.search({
            index: 'organization',
            body: makeESQuery()
          });
        }

        should.exist(response.hits);
        should.exist(response.hits.hits);
        response.hits.hits.should.have.length(1);
        should.exist(response.hits.hits[0]._source);
        const src = response.hits.hits[0]._source;
        const doc = _.pick(src,
          ['name', 'website', 'email', 'address', 'meta']);
        doc['id'] = response.hits.hits[0]._id;
        doc.should.deepEqual(compareData);
      });
    it('should delete indexed messages',
      async function consumeEvents(): Promise<void> {
        this.timeout(4000);
        await topic.emit('organizationDeleted', {
          id: data.id
        });

        await esClient.indices.refresh({ index: 'organization' });

        // Sleep due to eventual consistency
        await new Promise(resolve => setTimeout(resolve, 2000));

        const response = await esClient.search({
          index: 'organization',
          body: makeESQuery()
        });

        should.exist(response);
        should.exist(response.hits);
        should.exist(response.hits.hits);
        (response.hits.total as any).value.should.equal(0);
      });
    describe('fulltext search', () => {
      let orgA, orgB;
      const orgIDA = uuid.v4().replace(/-/g, '');
      const orgIDB = uuid.v4().replace(/-/g, '');
      before(async function (): Promise<void> {
        orgA = {
          id: orgIDA,
          name: 'Foo Bar',
          address: {
            country:
              { name: 'Germany' },
            street: 'Maximilianstraße',
            postcode: '81929',
            locality: 'Munich'
          },
          contact_point: {
            telephone: 17612345678,
            address: {
              country: { name: 'Germany' },
              street: 'HeadQuarterstraße1',
              postcode: '70412',
              locality: 'Berlin'
            },
          },
          email: "info@foobar.de",
          website: "http://foobar.de",
          meta: createMetadata(orgIDA)
        };

        orgB = {
          id: orgIDB,
          name: 'John Doe GmbH',
          address: {
            country:
              { name: 'Germany' },
            street: 'Tübingerstraße',
            postcode: '70178',
            locality: 'Stuttgart'
          },
          contact_point: {
            telephone: 176187654321,
            address: {
              country: { name: 'Germany' },
              street: 'HeadQuarterstraße2',
              postcode: '70123',
              locality: 'Hamburg'
            },
          },
          email: "info@johndoe.co",
          website: "http://johndoe.co",
          meta: createMetadata(orgIDB)
        };

        await esClient.bulk({
          index: 'organization',
          body: [
            { index: { _index: 'organization', _id: orgIDA } },
            orgA,
            { index: { _index: 'organization', _id: orgIDB } },
            orgB
          ]
        });


      });

      it('should retrieve documents by providing a text',
        async function (): Promise<void> {
          this.timeout(4000);

          await esClient.indices.refresh({ index: 'organization' });

          const searchAndValidate = async function (text: string,
            expectedLength: number): Promise<void> {
            // performing fulltext search
            const result = await searchService.search({
              collection: 'organization',
              text
            });
            should.exist(result);
            should.not.exist(result.error);
            should.exist(result.data);
            result.data.should.be.length(expectedLength);
          };

          // Search is based on ngram tokenizer with minimum search length
          // of 4 characters
          await searchAndValidate('Germany', 2);
          await searchAndValidate('straße', 2);
          await searchAndValidate('1234', 1);
          // search by phone_number
          await searchAndValidate('5678', 1);
          await searchAndValidate('1761', 2);
          await searchAndValidate('Foo Doe', 2);
          // case insensitive search
          await searchAndValidate('foo bar', 1);
          // Email search
          await searchAndValidate('info@', 2);
        });
    });
  });
});

function makeCreateOrgRequest(): any {
  const orgID = uuid.v4().replace(/-/g, '');
  return {
    id: orgID,
    meta: createMetadata(orgID),
    name: 'Test Organization',
    address: {
      country: {
        name: 'Germany'
      },
      street: 'Example Street',
      postcode: '55555',
      locality: 'Sample locality',
      geo_coordinates: {
        latitude: 784,
        longitude: 357
      }
    },
    email: 'restore@org.de',
    website: 'http://test.org'
  };
}

function createMetadata(orgID: string): any {
  const now = Date.now();
  return {
    created: now,
    modified: now,
    modified_by: 'AdminID',
    owner: [{
      id: 'test',
      value: 'test'
    }],
    acl: []
  };
}

function updateMetadata(obj: any): any {
  return {
    created: obj.meta.created,
    modified: Date.now(),
    modified_by: 'AdminID',
    owner: obj.meta.owner,
    acl: []
  };
}

function makeModifyOrgRequest(organization: any): any {
  return {
    id: organization.id,
    meta: updateMetadata(organization),
    email: 'contact@org.de'
  };
}

function makeDeleteOrgRequest(organization: any): any {
  return {
    id: organization.id
  };
}

function makeESQuery(): any {
  return bodybuilder().query('match', 'name', 'Test Organization').build();
}
