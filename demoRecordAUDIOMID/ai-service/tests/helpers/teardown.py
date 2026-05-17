import asyncio
import sys
from typing import Any


def assert_no_pending_stt_tasks(actor: Any | None = None) -> None:
    current_task = asyncio.current_task()
    leaked_tasks = [
        task
        for task in asyncio.all_tasks()
        if task is not current_task
        and not task.done()
        and task.get_name().startswith("stt-")
    ]
    assert (
        not leaked_tasks
    ), f"Leaked asyncio tasks: {[task.get_name() for task in leaked_tasks]}"

    if actor is not None:
        assert actor._audio_queue.qsize() == 0
        assert actor._recv_queue.qsize() == 0
        assert actor._persist_queue.qsize() == 0

        for task in (
            actor._send_task,
            actor._recv_task,
            actor._persist_task,
            actor._watchdog_task,
        ):
            if task is not None:
                assert task.done(), f"Actor task still alive: {task.get_name()}"

    main_module = sys.modules.get("app.main")
    if main_module is not None:
        assert not getattr(
            main_module, "_stt_stream_sessions", {}
        ), "STT actor registry is not empty"
