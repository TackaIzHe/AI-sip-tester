tackaizhe@Mihailov-Vitalia-PC:~/ai-tasks/task3/to$ npm run start

> sip-atc-test-server@0.1.0 start
> tsx server/main.ts

терминал сервера SIP-автотестов; команды: help, status, test <кейс|all>, quit
sip> node:events:497
      throw er; // Unhandled 'error' event
      ^

Error: listen EADDRINUSE: address already in use :::3000
    at Server.setupListenHandle [as _listen2] (node:net:1934:16)
    at listenInCluster (node:net:1991:12)
    at Server.listen (node:net:2096:7)
    at Function.listen (/home/tackaizhe/ai-tasks/task3/to/node_modules/express/lib/application.js:635:24)
    at <anonymous> (/home/tackaizhe/ai-tasks/task3/to/server/main.ts:19:20)
    at ModuleJob.run (node:internal/modules/esm/module_job:343:25)
    at async onImport.tracePromise.__proto__ (node:internal/modules/esm/loader:665:26)
    at async asyncRunEntryPointWithESMLoader (node:internal/modules/run_main:117:5)
Emitted 'error' event on Server instance at:
    at emitErrorNT (node:net:1970:8)
    at process.processTicksAndRejections (node:internal/process/task_queues:89:21) {
  code: 'EADDRINUSE',
  errno: -98,
  syscall: 'listen',
  address: '::',
  port: 3000
}

Node.js v22.22.1

