#!/usr/bin/env python3
"""Copy one SSH channel onto the bridge's agent socket. Bytes only."""

import os
import select
import socket
import sys

SOCK_PATH = os.environ.get("BRIDGE_SOCK", "/run/cursor-remote/agent.sock")


def main():
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    sock.connect(SOCK_PATH)
    infd = sys.stdin.fileno()
    outfd = sys.stdout.fileno()
    os.set_blocking(infd, False)
    os.set_blocking(outfd, False)
    sock.setblocking(False)
    to_out = bytearray()
    to_sock = bytearray()
    while True:
        readable_fds = []
        writable_fds = []
        if len(to_sock) < 1024 * 1024:
            readable_fds.append(infd)
        if len(to_out) < 1024 * 1024:
            readable_fds.append(sock)
        if to_out:
            writable_fds.append(outfd)
        if to_sock:
            writable_fds.append(sock)
        readable, writable, _ = select.select(readable_fds, writable_fds, [], 60)
        if infd in readable:
            data = os.read(infd, 65536)
            if not data:
                return
            to_sock += data
        if sock in readable:
            data = sock.recv(65536)
            if not data:
                return
            to_out += data
        if outfd in writable and to_out:
            n = os.write(outfd, to_out)
            del to_out[:n]
        if sock in writable and to_sock:
            n = sock.send(to_sock)
            del to_sock[:n]


if __name__ == "__main__":
    main()
