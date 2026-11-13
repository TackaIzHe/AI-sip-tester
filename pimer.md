                                                            │INVITE sip:u00s30p00@192.168.80.133:5060 SIP/2.0
           192.168.80.186:5060           192.168.80.133:5060│Via: SIP/2.0/UDP 192.168.80.186:5060;rport;branch=z9hG4bKPjf.6XnaslEtxERzi4WeTiWOQDVStFieBp
          ──────────┬─────────          ──────────┬─────────│Max-Forwards: 69
  15:07:20.362718   │        INVITE (SDP)         │         │From: "qwer" <sip:53@192.168.80.186;user=phone>;tag=1Kzy2Xhg8yNtV3UWlho-FiMToLkK6lSc
        +0.004660   │ ──────────────────────────> │         │To: <sip:123@192.168.80.186>
  15:07:20.367378   │         100 Trying          │         │Contact: <sip:53@192.168.80.186:5060>
        +0.000929   │ <────────────────────────── │         │Call-ID: u9U-Lx8PxtZVyaDmmK4jSyUG9Sjsej3l
  15:07:20.368307   │      180 Ringing (SDP)      │         │CSeq: 27552 INVITE
        +3.374080   │ <────────────────────────── │         │Allow: INVITE, ACK, BYE, CANCEL, UPDATE, PRACK, SUBSCRIBE, NOTIFY, REFER
  15:07:23.742387   │           CANCEL            │         │P-Coral-Info: 040c tr002c
        +0.005663   │ ──────────────────────────> │         │User-Agent: Coral pa_sip 3.402.0.100
  15:07:23.748050   │           200 OK            │         │Content-Type: application/sdp
        +0.000054   │ <────────────────────────── │         │Content-Length:   246
  15:07:23.748104   │   487 Request Terminated    │         │
        +0.004572   │ <────────────────────────── │         │v=0
  15:07:23.752676   │             ACK             │         │o=mgapp 1019385753 1674534434 IN IP4 192.168.80.186
                    │ ──────────────────────────> │         │s=-
                    │                             │         │c=IN IP4 192.168.80.186
                    │                             │         │t=0 0
                    │                             │         │m=audio 20062 RTP/AVP 8 0 101
                    │                             │         │a=rtpmap:8 PCMA/8000
                    │                             │         │a=rtpmap:0 PCMU/8000
                    │                             │         │a=rtpmap:101 telephone-event/8000
                    │                             │         │a=fmtp:101 0-15
                    │                             │         │a=ptime:20
                    │                             │         │a=sendrecv


вот так долже быть отправлен инвайт. вместо 192.168.80.186 нужно подставить нашь адрес

