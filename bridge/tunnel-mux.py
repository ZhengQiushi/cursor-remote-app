#!/usr/bin/env python3
"""Mac side of the bridge. One SSH session, many local connections to the relay."""

import asyncio
import contextlib
import json
import os
import re
import socket
import struct
import sys

HEADER = struct.Struct("!BII")
OPEN, DATA, CLOSE, PING, PONG, HELLO = 1, 2, 3, 4, 5, 6
MAX_FRAME = 256 * 1024
UPSTREAM = os.environ.get("BRIDGE_UPSTREAM", "127.0.0.1:3939")
SSH_HOST = os.environ.get("BRIDGE_SSH_HOST", "pre-server")
REMOTE_ATTACH = os.environ.get("BRIDGE_ATTACH", "python3 /usr/local/lib/cursor-remote-bridge/attach.py")


class Mux:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.write_lock = asyncio.Lock()
        self.local = {}
        self.pending = {}

    def log(self, msg):
        print(msg, file=sys.stderr, flush=True)

    async def send(self, typ, stream_id, payload=b""):
        try:
            async with self.write_lock:
                self.writer.write(HEADER.pack(typ, stream_id, len(payload)) + payload)
                await self.writer.drain()
            return True
        except Exception:
            return False

    async def pump_local(self, stream_id, reader, writer):
        try:
            while True:
                data = await reader.read(32768)
                if not data:
                    break
                if not await self.send(DATA, stream_id, data):
                    break
        finally:
            await self.send(CLOSE, stream_id)
            if self.local.get(stream_id) is writer:
                self.local.pop(stream_id, None)
            writer.close()

    async def open_stream(self, stream_id):
        host, port = UPSTREAM.rsplit(":", 1)
        try:
            reader, writer = await asyncio.open_connection(host, int(port))
        except Exception as exc:
            self.pending.pop(stream_id, None)
            self.log(f"upstream refused: {exc}")
            await self.send(CLOSE, stream_id)
            return
        sock = writer.get_extra_info("socket")
        if sock is not None:
            with contextlib.suppress(Exception):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        if stream_id not in self.pending:
            writer.close()
            return
        # Set the live writer before taking the queued bytes so nothing is dropped.
        self.local[stream_id] = writer
        queued = bytes(self.pending.pop(stream_id, b""))
        if queued:
            writer.write(queued)
            await writer.drain()
        asyncio.create_task(self.pump_local(stream_id, reader, writer))

    async def close_stream(self, stream_id):
        self.pending.pop(stream_id, None)
        writer = self.local.pop(stream_id, None)
        if writer is not None:
            writer.close()

    async def run(self):
        while True:
            hdr = await self.reader.readexactly(HEADER.size)
            typ, stream_id, length = HEADER.unpack(hdr)
            if length > MAX_FRAME:
                raise ValueError("frame too large")
            payload = await self.reader.readexactly(length) if length else b""
            if typ == OPEN:
                self.pending[stream_id] = bytearray()
                asyncio.create_task(self.open_stream(stream_id))
            elif typ == DATA:
                writer = self.local.get(stream_id)
                if writer is not None:
                    writer.write(payload)
                    await writer.drain()
                elif stream_id in self.pending:
                    self.pending[stream_id] += payload
            elif typ == CLOSE:
                await self.close_stream(stream_id)
            elif typ == PING:
                await self.send(PONG, 0, payload)
            elif typ == PONG:
                pass


async def drain_stderr(stream):
    while True:
        line = await stream.readline()
        if not line:
            return
        text = line.decode("utf-8", "replace").rstrip()
        if text and "post-quantum" not in text and "store now, decrypt later" not in text and "openssh.com/pq.html" not in text:
            print(text, file=sys.stderr, flush=True)


def load_identity():
    path = os.path.expanduser("~/.cursor-remote-lite/config.json")
    try:
        cfg = json.load(open(path))
    except Exception:
        cfg = {}
    cid = str(cfg.get("computerId") or "").strip()
    name = str(cfg.get("computerName") or socket.gethostname().split(".")[0] or "Mac").strip()[:80]
    if not re.fullmatch(r"[A-Za-z0-9_-]{6,64}", cid):
        cid = "mac-" + os.urandom(6).hex()
    return {"id": cid, "name": name}


async def main():
    sock_path = os.environ.get("BRIDGE_SOCK")
    if sock_path:
        reader, writer = await asyncio.open_unix_connection(sock_path)
        proc = None
    else:
        proc = await asyncio.create_subprocess_exec(
            "ssh", "-T",
            "-o", "ServerAliveInterval=15",
            "-o", "ServerAliveCountMax=3",
            "-o", "BatchMode=yes",
            SSH_HOST,
            *REMOTE_ATTACH.split(),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        reader, writer = proc.stdout, proc.stdin
        asyncio.create_task(drain_stderr(proc.stderr))
    mux = Mux(reader, writer)
    ident = load_identity()
    print(f"bridge session started {ident['name']}", file=sys.stderr, flush=True)
    try:
        await mux.send(HELLO, 0, json.dumps(ident).encode())
        await mux.run()
    finally:
        writer.close()
        if proc is not None:
            with contextlib.suppress(ProcessLookupError):
                proc.terminate()
            await proc.wait()


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except (asyncio.IncompleteReadError, ConnectionError, BrokenPipeError) as exc:
        print(f"bridge session ended: {exc}", file=sys.stderr, flush=True)
        sys.exit(1)
