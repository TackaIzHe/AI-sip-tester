// Флаг отладочного вывода SIP-транспорта — перенос task2/src/debug.ts.
// Сервер всегда работает в Node, браузерная ветка с typeof process убрана:
// SIP_DEBUG=1 npm start / SIP_DEBUG=1 npx tsx …

export const DEBUG = process.env.SIP_DEBUG === '1';
