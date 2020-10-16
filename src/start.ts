import * as Cluster from '@restorecommerce/cluster-service';
import { config  } from '@restorecommerce/chassis-srv';

const start = async(): Promise<void> => {
  const cfg = await config.get();
  const cluster = new Cluster(cfg);
  cluster.run('./lib/worker');
};

start().then().catch((err) => {
  console.error(err);
});
