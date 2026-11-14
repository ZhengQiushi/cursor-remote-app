#!/usr/bin/env python3
# Runs one command under a pseudo-terminal for the phone's terminal tab.
# usage: pty-helper.py COLS ROWS COMMAND [ARGS...]
# stdin (from the server), framed:  b"I" + u32 length + bytes  -> keyboard input for the program
#                                    b"R" + u16 cols + u16 rows -> window size
# stdout: the program's raw terminal output. Exit status: the program's own.
import fcntl
import os
import pty
import select
import signal
import struct
import sys
import termios

INPUT_MAX = 1 << 20


def set_size(fd, cols, rows):
    try:
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    except OSError:
        pass


def start_child(cols, rows, argv):
    pid, fd = pty.fork()
    if pid == 0:
        env = dict(os.environ)
        # Inherited from a Claude Code session that started this server: the program must not think it is nested.
        for key in ("CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SSE_PORT"):
            env.pop(key, None)
        env["TERM"] = "xterm-256color"
        env["COLORTERM"] = "truecolor"
        if "utf-8" not in (env.get("LANG", "") + env.get("LC_ALL", "")).lower():
            env["LANG"] = "en_US.UTF-8"  # Chinese input needs a UTF-8 locale; services often have none
        try:
            os.execvpe(argv[0], argv, env)
        except OSError as error:
            os.write(2, ("无法启动：%s\r\n" % error).encode("utf-8", "replace"))
            os._exit(127)
    set_size(fd, cols, rows)
    return pid, fd


def drain_frames(pending, fd):
    """Applies every complete frame in `pending`; returns False when the stdin is malformed."""
    while pending:
        kind = pending[:1]
        if kind == b"I":
            if len(pending) < 5:
                return True
            size = struct.unpack(">I", bytes(pending[1:5]))[0]
            if size > INPUT_MAX:
                return False
            if len(pending) < 5 + size:
                return True
            data = bytes(pending[5:5 + size])
            del pending[:5 + size]
            write_all(fd, data)
        elif kind == b"R":
            if len(pending) < 5:
                return True
            cols, rows = struct.unpack(">HH", bytes(pending[1:5]))
            del pending[:5]
            set_size(fd, cols, rows)
        else:
            return False
    return True


def write_all(fd, data):
    view = memoryview(data)
    while view:
        try:
            view = view[os.write(fd, view):]
        except BlockingIOError:
            select.select([], [fd], [], 1.0)
        except OSError:
            return


def main():
    cols, rows = int(sys.argv[1]), int(sys.argv[2])
    argv = sys.argv[3:]
    if not argv:
        sys.exit(2)
    pid, fd = start_child(cols, rows, argv)
    os.set_blocking(fd, False)
    stdin_open = True
    pending = bytearray()
    out = sys.stdout.buffer
    while True:
        watch = [fd, 0] if stdin_open else [fd]
        try:
            ready, _, _ = select.select(watch, [], [])
        except InterruptedError:
            continue
        if fd in ready:
            try:
                data = os.read(fd, 65536)
            except BlockingIOError:
                data = None
            except OSError:
                break  # EIO: the program has exited
            if data is not None:
                if not data:
                    break
                out.write(data)
                out.flush()
        if stdin_open and 0 in ready:
            chunk = os.read(0, 65536)
            if not chunk:
                # The server went away: hang up the program the way closing a window does.
                stdin_open = False
                try:
                    os.kill(pid, signal.SIGHUP)
                except OSError:
                    pass
                continue
            pending += chunk
            if not drain_frames(pending, fd):
                try:
                    os.kill(pid, signal.SIGHUP)
                except OSError:
                    pass
                stdin_open = False
    _, status = os.waitpid(pid, 0)
    if os.WIFSIGNALED(status):
        sys.exit(128 + os.WTERMSIG(status))
    sys.exit(os.WEXITSTATUS(status))


if __name__ == "__main__":
    main()
