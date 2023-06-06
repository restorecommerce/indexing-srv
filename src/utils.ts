import * as _ from 'lodash';

export interface Attribute {
  id: string;
  value: string;
}

export const getSubTreeOrgs = async (orgID: String, direction: string,
  graphService: any, cfg: any, logger: any): Promise<Set<string>> => {
  let subOrgTreeList = new Set<string>();
  const hierarchicalResources = cfg.get(
    'authorization:hierarchicalResources') || [];
  for (let hierarchicalResource of hierarchicalResources) {
    const {collection, edge} = hierarchicalResource;
    const start_vertex = `${collection}/${orgID}`;
    const result = await graphService.traversal({
      start_vertex, opts: {
        expander: [{edge, direction}]
      },
      path: true
    });
    let paths: any = [];
    while (result.read) {
      const resp = await result.read();
      // Promisify the callback containing result
      const partResp: any = await new Promise((resolve, reject) => {
        resp((err, response) => {
          if (err) {
            if (err.message === 'stream end') {
              resolve(null);
            }
            reject(err);
          }
          resolve(response);
        });
      });
      if (!partResp) {
        break;
      }
      if (partResp && partResp.paths && partResp.paths.value) {
        Object.assign(paths, JSON.parse(partResp.paths.value.toString()));
      }
    }

    if (result.error) {
      const errorMsg = 'Error when retrieving tree structures for role associations';
      logger.error(errorMsg, {
        error: result.error,
        details: result.error.details
      });
      throw new Error(errorMsg + ': ' + result.error.details);
    }

    for (let path of paths) {
      const edges = path.edges;
      if (_.isEmpty(edges)) {
        const vertex = path.vertices[0];
        const rootNode = vertex._id.split('/')[1];
        subOrgTreeList.add(rootNode);
      }
      for (let edge of edges) {
        // subOrgTreeList.push(vertice.id);
        // const latestEdge = edges[edges.length - 1];
        const parent: string = edge._to.split('/')[1];
        const child: string = edge._from.split('/')[1];
        subOrgTreeList.add(parent);
        subOrgTreeList.add(child);
      }
    }
  }
  return subOrgTreeList;
};

export const formatResourceType = (type: string): string => {
  // e.g: contact_point -> contact_point.ContactPoint
  const prefix = type;
  const suffixArray = type.split('_').map((word) => {
    return word.charAt(0).toUpperCase() + word.substring(1);
  });
  const suffix = suffixArray.join('');
  return `${prefix}.${suffix}`;
};

export const createResourceTarget = (resources: any[], action: string,
  cfg: any): any => {
  const flattened: Attribute[] = [];
  const urns = cfg.get('authorization:urns');
  resources.forEach((resource) => {
    const resourceType = formatResourceType(resource);
    if (resourceType) {
      flattened.push({
        id: urns.entity,
        value: urns.model + `:${resourceType}`
      });
    }
  });
  return flattened;
};

export const createActionTarget = (action: string, cfg: any): Attribute[] => {
  const urns = cfg.get('authorization:urns');
  return [{
    id: urns.actionID,
    value: urns.action + `:${action}`
  }];
};
