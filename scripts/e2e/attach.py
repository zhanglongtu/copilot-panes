#!/usr/bin/env python3
"""给独立的 tmux 服务接一个有尺寸的客户端（伪终端），这样 display-popup（界面的 o 键）才能弹出来。
用法：attach.py <秒数> [输出文件]   在后台运行；期间客户端的屏幕输出去掉转义码后写进输出文件，方便 grep 弹出窗口里的文字。
只连 -L cp-e2e（TMUX_SOCK 可换），不碰别的 tmux 服务。"""
import fcntl, os, pty, re, select, struct, sys, termios, time

seconds = float(sys.argv[1]) if len(sys.argv) > 1 else 60
out_path = sys.argv[2] if len(sys.argv) > 2 else None
sock = os.environ.get("E2E_TMUX_SOCK", "cp-e2e")

pid, fd = pty.fork()
if pid == 0:
    for name in ("TMUX", "TMUX_PANE"):
        os.environ.pop(name, None)
    os.environ["TERM"] = "xterm-256color"
    os.execvp("tmux", ["tmux", "-L", sock, "attach", "-t", "e2e"])
fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 200, 0, 0))
ansi = re.compile(rb"\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Za-z0-9]|\x1b[=>]")
end = time.time() + seconds
out = open(out_path, "ab") if out_path else None
try:
    while time.time() < end:
        r, _, _ = select.select([fd], [], [], 0.5)
        if fd in r:
            try:
                data = os.read(fd, 65536)
            except OSError:
                break
            if not data:
                break
            if out:
                out.write(ansi.sub(b"", data).replace(b"\r", b"\n"))
                out.flush()
finally:
    try:
        os.write(fd, b"\x02d")  # 前缀键 + d：正常脱离
    except OSError:
        pass
    time.sleep(0.5)
    try:
        os.kill(pid, 15)
    except ProcessLookupError:
        pass
