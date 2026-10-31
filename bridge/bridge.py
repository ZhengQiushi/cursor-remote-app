#!/usr/bin/env python3
"""Always-on bridge on the public server.

nginx talks to 127.0.0.1:3950. Several Macs can be connected at once. Each one
sends a HELLO with its id and name. The phone picks a computer with
/hub/c/<id>/...; /hub/computers lists who is online. A path without /hub/
still goes to the first computer, so an older phone keeps working.
"""

import asyncio
import contextlib
import json
import os
import re
import socket
import struct
import time

HEADER = struct.Struct("!BII")
OPEN, DATA, CLOSE, PING, PONG, HELLO = 1, 2, 3, 4, 5, 6
MAX_FRAME = 256 * 1024
LISTEN = os.environ.get("BRIDGE_LISTEN", "127.0.0.1:3950")
SOCK_PATH = os.environ.get("BRIDGE_SOCK", "/run/cursor-remote/agent.sock")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{6,64}$")
HUB_C = re.compile(r"^/hub/c/([A-Za-z0-9_-]+)(/[^?]*)?(\?.*)?$")


class Agent:
    def __init__(self, reader, writer):
        self.reader = reader
        self.writer = writer
        self.id = f"anon-{id(writer):x}"
        self.name = ""
        self.write_lock = asyncio.Lock()
        self.streams = {}
        self.next_id = 1
        self.last_rx = time.monotonic()

    async def send(self, typ, stream_id, payload=b""):
        try:
            async with self.write_lock:
                self.writer.write(HEADER.pack(typ, stream_id, len(payload)) + payload)
                await self.writer.drain()
            return True
        except Exception:
            return False

    def alloc(self):
        stream_id = self.next_id
        self.next_id = self.next_id + 1 if self.next_id < 0xFFFFFFFF else 1
        return stream_id

    async def close_streams(self):
        streams = list(self.streams.items())
        self.streams.clear()
        for _, writer in streams:
            writer.close()
            with contextlib.suppress(Exception):
                await writer.wait_closed()


class Bridge:
    def __init__(self):
        self.agents = {}
        self.legacy_id = None

    def log(self, msg):
        print(msg, flush=True)

    def legacy(self):
        agent = self.agents.get(self.legacy_id)
        return agent if agent is not None else None

    def rekey(self, agent, new_id, name):
        agent.name = name or new_id
        if agent.id == new_id:
            return
        previous = self.agents.get(new_id)
        if previous is not None and previous is not agent:
            previous.writer.close()
        was_legacy = self.legacy_id == agent.id
        if self.agents.get(agent.id) is agent:
            self.agents.pop(agent.id, None)
        agent.id = new_id
        self.agents[new_id] = agent
        if was_legacy or self.legacy_id is None:
            self.legacy_id = new_id
        self.log(f"agent {new_id} {agent.name}")

    async def read_frames(self, agent):
        try:
            while True:
                hdr = await asyncio.wait_for(agent.reader.readexactly(HEADER.size), timeout=50)
                typ, stream_id, length = HEADER.unpack(hdr)
                if length > MAX_FRAME:
                    raise ValueError("frame too large")
                payload = await agent.reader.readexactly(length) if length else b""
                agent.last_rx = time.monotonic()
                if typ == HELLO:
                    try:
                        info = json.loads(payload.decode())
                    except Exception:
                        continue
                    new_id = str(info.get("id") or "")
                    if not ID_RE.match(new_id):
                        continue
                    name = str(info.get("name") or "")[:80]
                    self.rekey(agent, new_id, name)
                elif typ == DATA:
                    client = agent.streams.get(stream_id)
                    if client is None:
                        continue
                    client.write(payload)
                    await client.drain()
                elif typ == CLOSE:
                    await self.drop_stream(agent, stream_id)
                elif typ == PING:
                    await agent.send(PONG, 0, payload)
        except Exception as exc:
            self.log(f"agent ended {agent.id}: {exc}")

    async def handle_agent(self, reader, writer):
        agent = Agent(reader, writer)
        self.agents[agent.id] = agent
        if self.legacy_id is None:
            self.legacy_id = agent.id
        self.log("agent connected")
        try:
            await self.read_frames(agent)
        finally:
            if self.agents.get(agent.id) is agent:
                self.agents.pop(agent.id, None)
                if self.legacy_id == agent.id:
                    self.legacy_id = None
            await agent.close_streams()
            writer.close()
            self.log(f"agent gone {agent.id}")

    async def drop_stream(self, agent, stream_id):
        client = agent.streams.pop(stream_id, None)
        if client is None:
            return
        client.close()
        with contextlib.suppress(Exception):
            await client.wait_closed()

    async def proxy(self, agent, reader, writer, initial):
        stream_id = agent.alloc()
        agent.streams[stream_id] = writer
        if not await agent.send(OPEN, stream_id):
            await self.drop_stream(agent, stream_id)
            return
        view = initial
        while view:
            chunk = view[:32768]
            view = view[32768:]
            if not await agent.send(DATA, stream_id, chunk):
                await agent.send(CLOSE, stream_id)
                await self.drop_stream(agent, stream_id)
                return
        try:
            while True:
                data = await reader.read(32768)
                if not data:
                    break
                if not await agent.send(DATA, stream_id, data):
                    break
        finally:
            await agent.send(CLOSE, stream_id)
            await self.drop_stream(agent, stream_id)

    def computers(self):
        out = []
        for agent in self.agents.values():
            if agent.id.startswith("anon-"):
                continue
            out.append({"id": agent.id, "name": agent.name or agent.id})
        out.sort(key=lambda c: c["name"])
        return out

    async def answer(self, writer, status, reason, body):
        head = (
            f"HTTP/1.1 {status} {reason}\r\n"
            "Content-Type: application/json; charset=utf-8\r\n"
            "Cache-Control: no-store\r\n"
            "Access-Control-Allow-Origin: *\r\n"
            f"Content-Length: {len(body)}\r\n"
            "Connection: close\r\n\r\n"
        ).encode()
        writer.write(head + body)
        with contextlib.suppress(Exception):
            await writer.drain()
        writer.close()

    async def handle_client(self, reader, writer):
        sock = writer.get_extra_info("socket")
        if sock is not None:
            with contextlib.suppress(Exception):
                sock.setsockopt(socket.IPPROTO_TCP, socket.TCP_NODELAY, 1)
        try:
            head = await read_head(reader)
        except Exception:
            writer.close()
            return
        split = head.find(b"\r\n\r\n")
        if split < 0:
            writer.close()
            return
        lines = head[:split].split(b"\r\n")
        parts = lines[0].split(b" ")
        if len(parts) < 2:
            writer.close()
            return
        path = parts[1].decode("latin1")
        path_only = path.split("?", 1)[0]
        if path_only.rstrip("/") == "/hub/computers":
            body = json.dumps({"computers": self.computers()}).encode()
            await self.answer(writer, 200, "OK", body)
            return
        target, rewritten = route_path(path)
        agent = self.agents.get(target) if target else self.legacy()
        if agent is None:
            body = json.dumps({"error": "offline"}).encode()
            await self.answer(writer, 502, "Bad Gateway", body)
            return
        if rewritten:
            parts[1] = rewritten.encode()
            lines[0] = b" ".join(parts)
            head = b"\r\n".join(lines) + b"\r\n\r\n" + head[split + 4:]
        await self.proxy(agent, reader, writer, head)

    async def ping(self):
        while True:
            await asyncio.sleep(15)
            for agent in list(self.agents.values()):
                if time.monotonic() - agent.last_rx > 50:
                    self.log(f"agent timed out {agent.id}")
                    agent.writer.close()
                    continue
                await agent.send(PING, 0, b"")


def route_path(path):
    match = HUB_C.match(path)
    if not match:
        return None, None
    suffix = match.group(2) or "/"
    return match.group(1), suffix + (match.group(3) or "")


async def read_head(reader):
    buf = bytearray()
    while b"\r\n\r\n" not in buf:
        chunk = await asyncio.wait_for(reader.read(4096), timeout=20)
        if not chunk:
            break
        buf += chunk
        if len(buf) > 65536:
            break
    return bytes(buf)


async def main():
    bridge = Bridge()
    host, port = LISTEN.rsplit(":", 1)
    os.makedirs(os.path.dirname(SOCK_PATH), exist_ok=True)
    with contextlib.suppress(FileNotFoundError):
        os.unlink(SOCK_PATH)
    tcp = await asyncio.start_server(bridge.handle_client, host, int(port))
    unix = await asyncio.start_unix_server(bridge.handle_agent, path=SOCK_PATH)
    os.chmod(SOCK_PATH, 0o600)
    bridge.log(f"listening {host}:{port}")
    asyncio.create_task(bridge.ping())
    async with tcp, unix:
        await asyncio.gather(tcp.serve_forever(), unix.serve_forever())


if __name__ == "__main__":
    asyncio.run(main())
