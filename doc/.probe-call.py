#!/usr/bin/env python3
# Зонд: какие варианты INVITE пропускает живая АТС. Звоним 1199 -> 52.
import socket, hashlib, re, time, sys

PBX = ('192.168.80.157', 5060)
ME_IP, ME_PORT = '192.168.80.159', 5099
FROM_NUM, TO_NUM = '1199', '52'
S = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
S.settimeout(2.0)
S.bind((ME_IP, ME_PORT))

cid = 0
def build(method, uri, to, extra='', body='', cseq=None, auth='', callid=None, contact=True, cseq_m=None):
    global cid
    if callid is None:
        cid += 1
        callid = f"probe{cid}@{ME_IP}"
    branch = f"z9hG4bK-probe{cid}-{int(time.time())%100000}"
    cseq = cseq or cid
    msg = (f"{method} {uri} SIP/2.0\r\n"
           f"Via: SIP/2.0/UDP {ME_IP}:{ME_PORT};branch={branch};rport\r\n"
           "Max-Forwards: 70\r\n"
           f"To: <sip:{to}@192.168.80.157:5060>\r\n"
           f"From: <sip:{FROM_NUM}@192.168.80.157:5060>;tag=pr{cid}\r\n"
           f"Call-ID: {callid}\r\n"
           f"CSeq: {cseq} {cseq_m or method}\r\n")
    if contact:
        msg += f"Contact: <sip:{FROM_NUM}@{ME_IP}:{ME_PORT};transport=udp>\r\n"
    if auth:
        msg += f"Authorization: {auth}\r\n"
    msg += extra
    msg += f"Content-Length: {len(body)}\r\n\r\n{body}"
    return msg

def tx(msg):
    S.sendto(msg.encode(), PBX)

def recv_until(final_only=True, timeout=6.0):
    """Ждёт финальный ответ, логируя промежуточные. Возвращает строку статуса."""
    end = time.time() + timeout
    while time.time() < end:
        try:
            data, _ = S.recvfrom(65535)
        except socket.timeout:
            return None
        line = data.decode(errors='replace').split('\r\n')[0]
        m = re.match(r'SIP/2\.0 (\d{3})', line)
        if m:
            code = int(m.group(1))
            if not final_only or code >= 200:
                if 100 < code < 200:
                    print(f"    (prov {code})", end=' ')
                    continue
                return code
    return None

# --- регистрация 1199 ---
tx(build("REGISTER", "sip:192.168.80.157:5060", FROM_NUM, "Expires: 300\r\n"))
code = recv_until()
print(f"REGISTER: {code}")

def invite_variant(name, from_num=None, to_num=None, ruri=None, sdp='', sdp_len=True, domain_port=True):
    from_u = from_num or FROM_NUM
    to_u = to_num or TO_NUM
    dom = "192.168.80.157:5060" if domain_port else "192.168.80.157"
    ruri = ruri or f"sip:{to_u}@{dom}"
    hdr = ""
    if sdp:
        hdr += "Content-Type: application/sdp\r\nAllow: ACK, BYE, CANCEL, INFO, OPTIONS\r\n"
    global cid
    cid += 1
    callid = f"probe{cid}@{ME_IP}"
    branch = f"z9hG4bK-p{cid}"
    msg = (f"INVITE {ruri} SIP/2.0\r\n"
           f"Via: SIP/2.0/UDP {ME_IP}:{ME_PORT};branch={branch};rport\r\n"
           "Max-Forwards: 70\r\n"
           f"To: <sip:{to_u}@{dom}>\r\n"
           f"From: <sip:{from_u}@{dom}>;tag=t{cid}\r\n"
           f"Call-ID: {callid}\r\n"
           f"CSeq: {cid} INVITE\r\n"
           f"Contact: <sip:{from_u}@{ME_IP}:{ME_PORT};transport=udp>\r\n"
           f"Supported: replaces\r\n{hdr}"
           f"Content-Length: {len(sdp)}\r\n\r\n{sdp}")
    tx(msg)
    print(f"[{name}] ...", end=' ')
    code = recv_until(timeout=7)
    if code is None:
        print("TIMEOUT")
        return None
    print(code)
    if code == 401 or code == 407:
        # ответ с паролем-мусоркой — проверка, есть ли вообще challenge
        data = None
        return code
    if 180 <= code < 190 or code == 183:
        # гудки: отменяем (CANCEL тем же branch)
        cancel = (f"CANCEL {ruri} SIP/2.0\r\n"
                  f"Via: SIP/2.0/UDP {ME_IP}:{ME_PORT};branch={branch};rport\r\n"
                  "Max-Forwards: 70\r\n"
                  f"To: <sip:{to_u}@{dom}>;tag=x\r\n"
                  f"From: <sip:{from_u}@{dom}>;tag=t{cid}\r\n"
                  f"Call-ID: {callid}\r\nCSeq: {cid} CANCEL\r\nContent-Length: 0\r\n\r\n")
        tx(cancel)
        recv_until(timeout=3)
    elif code == 200:
        # ACK + сразу BYE
        tx(f"ACK {ruri} SIP/2.0\r\nVia: SIP/2.0/UDP {ME_IP}:{ME_PORT};branch=z9hG4bK-a{cid};rport\r\n"
           f"Max-Forwards: 70\r\nTo: <sip:{to_u}@{dom}>;tag=y\r\nFrom: <sip:{from_u}@{dom}>;tag=t{cid}\r\n"
           f"Call-ID: {callid}\r\nCSeq: {cid} ACK\r\nContent-Length: 0\r\n\r\n")
        bye = (f"BYE {ruri} SIP/2.0\r\nVia: SIP/2.0/UDP {ME_IP}:{ME_PORT};branch=z9hG4bK-b{cid};rport\r\n"
               f"Max-Forwards: 70\r\nTo: <sip:{to_u}@{dom}>;tag=y\r\nFrom: <sip:{from_u}@{dom}>;tag=t{cid}\r\n"
               f"Call-ID: {callid}\r\nCSeq: {cid+1} BYE\r\nContent-Length: 0\r\n\r\n")
        tx(bye)
        recv_until(timeout=3)
    return code

SDP_LOOP = ("v=0\r\no=- 3700000000 3700000000 IN IP4 127.0.0.1\r\ns=sip-webphone\r\n"
            "c=IN IP4 127.0.0.1\r\nt=0 0\r\nm=audio 9 RTP/AVP 0\r\na=inactive\r\n")
SDP_REAL_INACTIVE = ("v=0\r\no=- 3700000000 3700000000 IN IP4 192.168.80.159\r\ns=sip-webphone\r\n"
            "c=IN IP4 192.168.80.159\r\nt=0 0\r\nm=audio 9 RTP/AVP 0\r\na=inactive\r\n")
SDP_REAL_ACTIVE = ("v=0\r\no=- 3700000000 3700000000 IN IP4 192.168.80.159\r\ns=sip-webphone\r\n"
            "c=IN IP4 192.168.80.159\r\nt=0 0\r\nm=audio 40000 RTP/AVP 0 8 101\r\na=rtpmap:0 PCMU/8000\r\n"
            "a=rtpmap:8 PCMA/8000\r\na=rtpmap:101 telephone-event/8000\r\na=sendrecv\r\n")

invite_variant("1 baseline (как приложение: sdp 127.0.0.1 port9 inactive)", sdp=SDP_LOOP)
invite_variant("2 sdp реальный IP, port9 inactive", sdp=SDP_REAL_INACTIVE)
invite_variant("3 sdp реальный IP, реальный порт, sendrecv (полный медиа)", sdp=SDP_REAL_ACTIVE)
invite_variant("4 baseline, но домены URI без :5060", sdp=SDP_LOOP, domain_port=False)
invite_variant("5 реальный IP inactive, домены без :5060", sdp=SDP_REAL_INACTIVE, domain_port=False)
invite_variant("6 без SDP вообще", sdp="")

# снять регистрацию
time.sleep(0.3)
tx(build("REGISTER", "sip:192.168.80.157:5060", FROM_NUM, "Expires: 0\r\n"))
recv_until(timeout=3)
print("unregistered")
