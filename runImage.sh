#!/bin/bash
docker run \
 --name indexing-srv \
 --hostname indexing-srv \
 --network=system_restorecommerce \
 -e NODE_ENV=production \
 -p 50051:50051 \
restorecommerce/indexing-srv

