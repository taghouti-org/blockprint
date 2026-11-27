#!/usr/bin/env bash
# start | stop | restart | status the Blockprint server (port 8090, localhost; published on the tailnet by tailscale serve)
cd "$(dirname "$0")"
[ -f ~/.config/plan2world/env ] && { set -a; . ~/.config/plan2world/env; set +a; }
PORT=${PORT:-8090}; PIDF=.server.pid
owner() { ss -ltnpH "sport = :$PORT" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }
stop() {
  for p in $(cat $PIDF 2>/dev/null) $(owner); do kill "$p" 2>/dev/null; done
  for i in $(seq 1 20); do [ -z "$(owner)" ] && break; sleep 0.5; done
  rm -f $PIDF
}
start() {
  if [ -n "$(owner)" ]; then echo "already running (pid $(owner)); use: $0 restart"; return 1; fi
  PORT=$PORT HOSTS=${HOSTS:-127.0.0.1} nohup node server.js >> server.log 2>&1 &
  echo $! > $PIDF
  for i in $(seq 1 60); do [ -n "$(owner)" ] && curl -s -o /dev/null "http://127.0.0.1:$PORT/api/showcases" && { echo "up (pid $(cat $PIDF))"; return 0; }; sleep 1; done
  echo "failed to start"; tail -20 server.log; return 1
}
case "$1" in
  stop) stop ;;
  restart) stop; start ;;
  status) [ -n "$(owner)" ] && echo "running (pid $(owner))" || echo "stopped" ;;
  *) start ;;
esac
