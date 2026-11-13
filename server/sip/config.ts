// Настройки одного виртуального SIP-абонента — перенос task2/src/config.ts
// (plan_2.md §2.1), упрощённый: только host/sip_port/number/password/transport.
// Режим подключения один — классический SIP UDP/TCP (фабрика транспортов);
// браузерные ветки ws/wss/bridge, localStorage и миграции из task2 убраны.

import type { SipTransport } from './transport';

export interface PhoneConfig
{
    /** Хост/IP АТС (user-часть SIP-URI и realm-aдрес, doc/sip_rfc.md §3.1). */
    host: string;
    /** Порт классического SIP на АТС (для SIP-URI). */
    sip_port: number;
    /** Внутренний номер на станции (SIP-URI + Digest username, doc/sip_rfc.md §5.10). */
    number: string;
    /** Digest-пароль для 401/407 (doc/sip_rfc.md §5.4). */
    password: string;
    /** Транспорт до станции (doc/sip_rfc.md §13). */
    transport: SipTransport;
}
