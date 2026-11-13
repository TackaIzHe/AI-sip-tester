# Анализ утечки памяти по логам (Eltex SMG, CORAL 17.1.13 / SIP-адаптер pa_sip 3.402)

Дата анализа: 2026-11-05. Набор трасс: `traces (2)`, `traces (3)`, `traces (Prime)`, `traces (Second)`, `traces 20260824`, `traces_max_load`, `traces_normal_load`.

## 1. Подтверждение: система действительно убивается по OOM

**Все** 16 логов главного процесса `app` (`app_log_*.log`) во всех наборах трассировки заканчиваются строкой **`Killed`** (SIGKILL — OOM-killer). Убийство происходит стабильно через ~30–40 с после старта — сразу после фазы `SIP. Send total config / Total config sent` (конфигурация 8 SIP-интерфейсов и тысяч портов):

```
 02/11/26  12:30:20.107164  [INFO] SIP. Send total config. Intrf-count: 8
 02/11/26  12:30:24.098882  [INFO] ivr: init.
 02/11/26  12:30:24.104171  [INFO] zmq server: start. pid 2841
Killed
```

(`traces (3)/tmp/log/app_log_20261102_122945.log`, то же в `traces (Prime)`, `traces (Second)`, `traces (2)`, даты 10.09–02.11 — крахи повторяются на 4 устройствах.)

**Core-dump'ы тоже это подтверждают.** Распакованы оба `gzcore_*_mod_rdn_.lzo` (~104 МБ виртуальной памяти каждый). В них строки:

- `malloc failed`
- `mod_rdn: core/udns_resolver.c:457: dns_new: Assertion (copy->dnsc_flags & DNS_INITED) failed.` (Sep 28)
- `core/udns_resolver.c:303: dns_set_opt: Assertion (ctx->dnsc_flags & DNS_INITED) failed.` (Nov 2)

Т.е. `mod_rdn` abort'ится, потому что `udns_init` **не смог выделить память** — он *жертва* общего дефицита памяти, а не виновник. Виновник — процесс, наевший память заранее; по косвенным признакам (крах сразу после SIP-конфига, лавина необработанных SIP-сообщений в SIP-логах) — адаптер `pa_sip`.

⚠️ Важно: SIP debug-логи покрывают всего 4–13 минут работы (ротируются по 20 МБ при 5-м уровне трассировки!), а pcap'ы сняты **спустя ~2 часа** после логов — прямого перекрытия «лог + трафик» нет, это дырка в данных.

## 2. Все возможные места утечки в SIP-адаптере (по убыванию вероятности)

### 🥇 A. `blf.c : blf_on_rx_notify()` — NOTIFY с непарсящимся dialog-info XML

Самый частый «не могу обработать» — **до 400 событий за 4 минуты** (стабильно ~1.5/сек часами):

```
blf.c  blf_on_rx_notify: BLF sub 2307 body xml unexpected: no remote/identity el
blf.c  blf_on_rx_notify: BLF sub 0750 body xml invalid: no dialog el
```

| лог | таких ошибок |
|---|---|
| traces 20260824/pbx_sip.1.log | 402 |
| traces_max_load/pbx_sip.1.log | 340 |
| traces_normal_load/pbx_sip.1.log | 289 |
| traces_normal_load/pbx_sip.2.log | 286 |

Путь: `mod_pa_subscription.c: sub_on_rx_notify_uac():683 → blf_on_rx_notify()`. Тело NOTIFY (~1–2 КБ) + разобранное XML-дерево аллоцируются до ошибки; на error-return освобождение дерева — классическое место утечки. Даже 10 КБ/ошибка × 1.5/сек ≈ **50 МБ/час**.

### 🥈 B. `ss_info.c : ss_on_rx_notify()` — NOTIFY пакета `event-list` (SSW_SRVM, distinctive_ring)

Сценарный «сообщение, которое адаптер не может обработать»: значения свойств приходят фиксированного размера 137–139 байт при лимите **32 байта**:

```
ss_info.c  ss_on_rx_notify: SSW_SRVM sub 073c bad property list: value 0x7f7eae37c8
  ({&quot;prefix&quot;:&quot;67805&quot;,&quot;media&quot;:&quot;system://sounds/ring/default.wav&quot;,...}, len 137, allowed 32)
ss_info.c  ss_on_rx_notify: ... bad property: name (replace_category_from_redirection, len 33, allowed 32)
```

По **каждому** префиксу в списке (на каждую сотню номеров провижининга!) выделяется свойство (показатели растут шагом 0xA0 — 160 байт) и отвергается. При удалённом refresh подписки NOTIFY повторяется — при отсутствии free на error-пути утекает весь список свойств на каждый NOTIFY.

### 🥉 C. `mod_pa_subscription.c : sub_create_uac()` — путь ошибки «sub already active»

```
sub_create_uac: BLF sub 0734 already active     (~150 шт. за 15 минут, max_load)
sub_create_uac: SSW_SRVM sub 073c already active
```

Дубли подписок от `app` при рестартах/пере-конфигурации. Если `pj_evsub`/pool выделяется **до** проверки «already active» и не освобождается на возврате ошибки — утечка на каждый дубль (а их шквал при каждом полном конфиге, т.е. при каждом рестарте app — которые у вас OOM-циклятся).

### 4. `sip_auth_client.c` — исходящие запросы с неизвестным realm (нет обработки 401 без credentials)

```
sip_auth_client.c  Unable to set auth for tdta0x...: can not find credential for GUmvd/Digest
reg_port.c         regc_cb: reg 0ee7 error: code 401     (по 5–22 на лог)
```

`tdta` (transaction data) уже создана к моменту отказа авторизации; REGISTER-клиент зациклен на 401. В этом окне `tsx destroyed` видно, но сам объект `tdta` создаётся **до** проверки учётных данных — кандидат на утечку по error-return. Провайдер шлёт 401 с realm `GUmvd`, которого нет в конфиге.

### 5. `ipc.c/ipc_msg.c` — необработанные IPC-сообщения от app

```
ipc.c       ipc_process: subscribe [54] error 70004: Invalid value or argument (PJ_EINVAL)
ipc_msg.c   ipc_msg_parse: msg type = subscribe [54]   (~400 на окно лога)
```

Буфер IPC-сообщения может выделяться до валидации — утечка на каждое невалидное subscribe.

### 6. `mod_pa_transit_ab.c` — входящие REGISTER/SUBSCRIBE «не от транка»

```
mod_pa_transit_ab.  Request msg SUBSCRIBE/cseq=1 (rdata0x...) request not from trunk
```

До **256–281 за 4 минуты** (REGISTER×123, SUBSCRIBE×122 в normal_load). Чужие устройства шлют сообщения с `cseq=1` (пересоздают диалог с нуля). Обработка идёт полным ходом (парсинг, rdata, резолвер, формирование ответа) до отказа — кандидат при утечке rdata/диалогов на reject-пути.

### 7. Косвенное: резолвер-путь `utils.c : ext_domain_resolver()`

Вызывается на **каждое** исходящее сообщение — 7 860–8 320 вызовов за окно лога (~35/сек); каждый гоняет запрос в `mod_rdn` (5–7k `cmd-resolve` в его логе). Прямых следов неосвобождённых очередей нет, но при деградации `mod_rdn` (два abort'а) очередь неразобранных ответов может накапливаться в адаптере.

## 3. Что НЕ подтвердилось

- Транзакции/диалоги PJSIP в поле зрения балансируются (`Transaction created/destroyed`, `Session count inc/dec`) — утечка не в базовом жизненном цикле tsx/dlg.
- `messages` (syslog) пусты во всех архивах (в т.ч. в `msg_*.tar.gz` внутри — пустой файл), kernel OOM-строк нет; `stack_*.log`/`switchd_*` — логи коммутационного стека, к проблеме не относятся.
- В pcap (13:24–13:25, max_load) атаки нет — это RTP-стримы нагрузочного теста; SIP там штучный.

## 4. Сводная таблица частоты кандидатов по логам

| файл лога | blf xml-err | ss_info badprop | auth fail | 401 reg | not from trunk |
|---|---|---|---|---|---|
| traces 20260824/pbx_sip.1.log | 402 | 4 | 38 | 13 | 217 |
| traces 20260824/pbx_sip.2.log | 77 | 2 | 7 | 5 | 88 |
| traces (2)/pbx_sip.1.log | 15 | 0 | 2 | 0 | 0 |
| traces_max_load/pbx_sip.1.log | 340 | 15 | 23 | 10 | 167 |
| traces_max_load/pbx_sip.2.log | 121 | 0 | 16 | 9 | 85 |
| traces_max_load/pbx_sip.3.log | 124 | 0 | 17 | 6 | 74 |
| traces_normal_load/pbx_sip.1.log | 289 | 6 | 46 | 22 | 256 |
| traces_normal_load/pbx_sip.2.log | 286 | 2 | 53 | 22 | 281 |
| traces_normal_load/pbx_sip.3.log | 57 | 0 | 7 | 0 | 67 |
| traces (Prime)/pbx_sip.1.log | 36 | 0 | 0 | 0 | 0 |
| traces (Second)/pbx_sip.1.log | 0 | 0 | 0 | 0 | 0 |

## 5. Рекомендации по локализации (следующие шаги)

1. Снимать **одновременно**: `/proc/<pid pa_sip>/status` (VmRSS) раз в 10 с + pcap 5060 + SIP-лог (без ротации 20 МБ). Скоррелировать скачок RSS с конкретным входящим сообщением.
2. Прогнать целенаправленные сценарии на тестовом стенде:
   - (a) NOTIFY с dialog-info без `<dialog>` / без `<remote><identity>`;
   - (b) event-list NOTIFY с property > 32 байт;
   - (c) повторный subscribe на активную подписку;
   - (d) 401 с неизвестным realm;
   - (e) REGISTER/SUBSCRIBE cseq=1 с чужого устройства.
3. Если есть сборка с отладочными символами — прогнать `pa_sip` под valgrind/massif или jemalloc-prof на сценариях выше.
4. Временно: обнулить подписки distinctive-ring (SSW_SRVM) и BLF на проблемном провайдере — если рост RSS остановится, это подтвердит пункты A/B.
