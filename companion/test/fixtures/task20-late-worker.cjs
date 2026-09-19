const { parentPort } = require("node:worker_threads");

setTimeout(() => parentPort.postMessage("ready"), 250);
