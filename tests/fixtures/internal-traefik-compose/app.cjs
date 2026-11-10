const grpc = require("@grpc/grpc-js");
const protobuf = require("protobufjs");
const { createGrpcHealth } = require("@tutor-matcher/shared");
const http = require("node:http");

const hostname = process.env.HOSTNAME || "fixture";
let httpReady = true;
let grpcReady = true;
const pingRequest = new protobuf.Type("PingRequest").add(
  new protobuf.Field("nonce", 1, "string"),
);
const pingResponse = new protobuf.Type("PingResponse")
  .add(new protobuf.Field("instance", 1, "string"))
  .add(new protobuf.Field("authorization", 2, "string"))
  .add(new protobuf.Field("nonce", 3, "string"));
const encode = (type, value) => Buffer.from(type.encode(type.fromObject(value)).finish());
const decode = (type, value) => type.toObject(type.decode(value), { defaults: true });

const grpcServer = new grpc.Server();
grpcServer.addService(
  {
    ping: {
      path: "/fixture.v1.Probe/Ping",
      requestStream: false,
      responseStream: false,
      requestSerialize: (value) => encode(pingRequest, value),
      requestDeserialize: (value) => decode(pingRequest, value),
      responseSerialize: (value) => encode(pingResponse, value),
      responseDeserialize: (value) => decode(pingResponse, value),
    },
  },
  {
    ping: (call, callback) => {
      const authorization = String(call.metadata.get("authorization")[0] || "");
      if (authorization !== "Bearer internal-fixture-canary") {
        callback({ code: grpc.status.UNAUTHENTICATED, details: "invalid workload identity" });
        return;
      }
      callback(null, { instance: hostname, authorization, nonce: call.request.nonce });
    },
  },
);
const health = createGrpcHealth(grpcServer, ["fixture.v1.Probe"], () => grpcReady);

const httpServer = http.createServer((request, response) => {
  if (request.url === "/health") {
    response.writeHead(httpReady ? 200 : 503, { "content-type": "application/json" });
    response.end(JSON.stringify({ status: httpReady ? "OK" : "NOT_SERVING" }));
    return;
  }
  if (request.url?.startsWith("/admin/ready?value=")) {
    const query = new URL(request.url, "http://fixture").searchParams;
    const value = query.get("value") === "true";
    const protocol = query.get("protocol");
    if (!protocol || protocol === "http") httpReady = value;
    if (!protocol || protocol === "grpc") grpcReady = value;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ httpReady, grpcReady }));
    return;
  }
  response.writeHead(200, { "content-type": "application/json" });
  response.end(JSON.stringify({ instance: hostname, identity: request.headers["x-identity"] || "" }));
});

httpServer.listen(8080, "0.0.0.0");
grpcServer.bindAsync("0.0.0.0:50051", grpc.ServerCredentials.createInsecure(), (error) => {
  if (error) throw error;
  health.setServing(true);
});

function stop() {
  health.shutdown();
  httpServer.close();
  grpcServer.tryShutdown(() => process.exit(0));
}
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
