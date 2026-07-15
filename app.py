import asyncio
import io
import json
import os
import queue
import subprocess
import threading
import time

import gradio as gr

# 统一用 dub9（与实时配音/服务器同一份代码）。以后只维护 dub9，dub8 已停用。
# 保留 `as dub8` 别名，下方所有 dub8.xxx 引用无需改动。
import dub9 as dub8


def schedule_shutdown(enabled, delay_seconds=60):
    """任务结束后倒计时关机（Windows）。返回提示文字，未启用时返回空串。
    用户可在弹出的命令行运行 shutdown /a 取消。"""
    if not enabled:
        return ''
    try:
        if os.name == 'nt':
            subprocess.Popen(['shutdown', '/s', '/t', str(delay_seconds)],
                             creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
        else:
            subprocess.Popen(['shutdown', '-h', f'+{max(delay_seconds // 60, 1)}'])
        return (f"\n\n💤 已设置 {delay_seconds} 秒后自动关机。"
                f"如需取消，请在命令行运行：shutdown /a")
    except Exception as e:
        return f"\n\n⚠ 设置自动关机失败：{e}（请手动关机）"

LAST_RUN_PATH = os.path.join(os.path.dirname(dub8.OUTPUT_DIR), 'last_run_state.json')


def save_run_state(**kwargs):
    try:
        with open(LAST_RUN_PATH, 'w', encoding='utf-8') as f:
            json.dump(kwargs, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def load_run_state():
    if not os.path.exists(LAST_RUN_PATH):
        return None
    try:
        with open(LAST_RUN_PATH, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def sanitize_for_gradio(value):
    """去掉 surrogate 字符，避免 Gradio/orjson SSE 推送时报错。"""
    if value is None:
        return value
    if isinstance(value, str):
        return value.encode('utf-8', errors='replace').decode('utf-8')
    if isinstance(value, list):
        return [sanitize_for_gradio(v) for v in value]
    if isinstance(value, tuple):
        return tuple(sanitize_for_gradio(v) for v in value)
    return value


class QueueWriter(io.TextIOBase):
    """把print()输出实时塞进队列，供界面轮询显示"""
    def __init__(self, q):
        self.q = q

    def write(self, s):
        if s:
            # orjson (used by Gradio SSE) rejects strings with surrogate codepoints
            s = s.encode('utf-8', errors='replace').decode('utf-8')
            self.q.put(s)
        return len(s)

    def flush(self):
        pass


def stream_call(fn, *args, **kwargs):
    """在后台线程跑fn并实时把它的print输出yield出来，
    最后一次yield带上fn的返回值。用法：for text, result in stream_call(...)"""
    log_q = queue.Queue()
    writer = QueueWriter(log_q)
    box = {'result': None}

    def worker():
        import sys
        old = sys.stdout
        sys.stdout = writer
        try:
            box['result'] = fn(*args, **kwargs)
        except Exception as e:
            log_q.put(f"\n❌ 出错：{e}\n")
        finally:
            sys.stdout = old
            log_q.put(None)

    threading.Thread(target=worker, daemon=True).start()
    out = ""
    last = time.time()
    nspin = 0
    while True:
        try:
            item = log_q.get(timeout=2)
        except queue.Empty:
            idle = int(time.time() - last)
            nspin += 1
            yield sanitize_for_gradio(out + f"\n  {'⏳⌛'[nspin % 2]} 处理中… 已 {idle}s（请稍候）"), None
            continue
        if item is None:
            break
        out += item
        last = time.time()
        yield sanitize_for_gradio(out), None
    result = box['result']
    if isinstance(result, list):
        result = [sanitize_for_gradio(x) if isinstance(x, str) else x for x in result]
    yield sanitize_for_gradio(out), result


def notify_done(title, message):
    """任务完成提醒：响一声 + 弹Windows对话框（常驻直到点击关闭）"""
    try:
        import winsound
        winsound.MessageBeep(winsound.MB_ICONASTERISK)
    except Exception:
        pass
    try:
        import ctypes
        # 0x40 = 信息图标；对话框会一直显示直到用户点"确定"
        threading.Thread(
            target=lambda: ctypes.windll.user32.MessageBoxW(0, message, title, 0x40),
            daemon=True
        ).start()
    except Exception:
        pass


def _parse_male_nums(text, n):
    """解析"男声序号"输入（如 "1,3,5" / "1 3 5" / "1、3"），返回 1..n 范围内的序号集合。"""
    s = str(text or '')
    for ch in ('，', ',', '、', '；', ';', '\n', '\t'):
        s = s.replace(ch, ' ')
    males = set()
    for tok in s.split():
        if tok.isdigit():
            k = int(tok)
            if 1 <= k <= n:
                males.add(k)
    return males


def _genders_from_male_nums(text, n):
    """按"男声序号"生成 n 个性别：列出的序号为男，其余为女。"""
    males = _parse_male_nums(text, n)
    return ['男' if i in males else '女' for i in range(1, n + 1)]


def run_pipeline(links_text, male_nums_text, subtitle_mode, bilingual,
                  male_voice, female_voice, target_lang,
                  original_volume, vocal_separation, source_video_dir, bilibili_charging):
    links = [l.strip() for l in links_text.splitlines() if l.strip()]
    if not links:
        yield "请至少粘贴一个视频链接。"
        return

    # 性别：用户填的"男声序号"为男，其余默认女，与链接逐行对应
    genders = _genders_from_male_nums(male_nums_text, len(links))
    genders_text = '\n'.join(genders)   # 兼容 save_run_state 的持久化

    save_run_state(
        links_text=links_text, genders_text=genders_text, male_nums_text=male_nums_text,
        subtitle_mode=subtitle_mode,
        bilingual=bilingual, male_voice=male_voice, female_voice=female_voice,
        target_lang=target_lang, original_volume=original_volume,
        vocal_separation=vocal_separation, source_video_dir=source_video_dir,
    )

    # 应用界面上的配置
    dub8.SUBTITLE_MODE = subtitle_mode
    dub8.BILINGUAL_SUBTITLE = bilingual if dub8.USER_TIER == 'premium' else False
    dub8.TARGET_LANG = target_lang
    dub8.VOICE_MAP = {'男': male_voice, '女': female_voice}
    dub8.ORIGINAL_AUDIO_VOLUME = original_volume
    dub8.VOCAL_SEPARATION_ENABLED = vocal_separation
    dub8.BILIBILI_CHARGING_ENABLED = bool(bilibili_charging)
    dub8.CURRENT_BG_MIX_VOLUME = None
    if source_video_dir.strip():
        dub8.SOURCE_VIDEO_DIR = source_video_dir.strip()

    log_q = queue.Queue()
    writer = QueueWriter(log_q)

    def worker():
        import sys
        old_stdout = sys.stdout
        sys.stdout = writer
        try:
            asyncio.run(dub8.run_all(links, genders))
        except Exception as e:
            log_q.put(f"\n❌ 运行出错：{e}\n")
        finally:
            sys.stdout = old_stdout
            log_q.put(None)  # 结束标记

    t = threading.Thread(target=worker, daemon=True)
    t.start()

    output_text = ""
    last = time.time()
    spins = '⏳⌛'
    nspin = 0
    while True:
        try:
            item = log_q.get(timeout=2)
        except queue.Empty:
            # 静默期（下载/翻译/合成中）：刷一行心跳，秒数在跳=活着；长时间不跳=真卡了
            idle = int(time.time() - last)
            nspin += 1
            hint = '（正在下载/翻译/合成，请稍候）' if idle < 150 else '（已较久无输出，可能卡住，必要时去“服务管理”关掉重来）'
            yield output_text + f"\n  {spins[nspin % 2]} 处理中… 已 {idle}s 无新进展{hint}"
            continue
        if item is None:
            break
        output_text += item
        last = time.time()
        yield output_text

    notify_done("配音任务完成", "全部视频的配音处理已结束。")
    yield output_text + "\n\n✅ 全部任务结束。"


with gr.Blocks(title="YouTube 自动配音工具") as demo:
    gr.Markdown("# YouTube 自动配音 / 字幕工具\n粘贴一个或多个 YouTube 链接（每行一个），点击开始处理。")

    with gr.Group(visible=False) as resume_group:
        resume_msg = gr.Markdown()
        with gr.Row():
            resume_btn = gr.Button("继续上次任务", variant="primary")
            dismiss_resume_btn = gr.Button("忽略")

    with gr.Row():
        with gr.Column(scale=1):
            links_box = gr.Textbox(
                label="视频链接（每行一个）",
                lines=8,
                placeholder="https://youtu.be/xxxxx\nhttps://youtu.be/yyyyy"
            )
            with gr.Group():
                playlist_msg = gr.Markdown(visible=False)
                playlist_choice = gr.Radio(
                    ["仅下载该视频", "下载整个播放列表"],
                    value="仅下载该视频", label="检测到播放列表链接",
                    visible=False,
                )
                playlist_confirm_btn = gr.Button("确认", visible=False)
            playlist_state = gr.State(None)
            check_playlist_btn = gr.Button("检查播放列表")
            male_nums_box = gr.Textbox(
                label="男声链接序号（填写哪些链接是男声，如 1,3,5；其余默认女声）",
                placeholder="例如：1,3,5　（留空＝全部女声）",
                value="",
                lines=2,
            )
            subtitle_mode = gr.Radio(
                ["none", "soft", "hard"],
                value="none",
                label="字幕模式",
                info="none=不加字幕；soft=软字幕(几乎不增加耗时，但B站等网站上传后不显示)；"
                     "hard=硬字幕烧录(耗时与视频长度成正比，所有平台可见)"
            )
            bilingual = gr.Checkbox(label="双语字幕（付费功能，免费版自动忽略）", value=False)
            male_voice = gr.Dropdown(
                dub8.MALE_VOICES, value=dub8.MALE_VOICES[0], label="男声配音员")
            female_voice = gr.Dropdown(
                dub8.FEMALE_VOICES, value=dub8.FEMALE_VOICES[0], label="女声配音员")
            target_lang = gr.Textbox(label="目标语言", value=dub8.TARGET_LANG)

            original_volume = gr.Slider(
                0, 1, value=dub8.ORIGINAL_AUDIO_VOLUME, step=0.05,
                label="原声音量比例",
                info="0=完全静音原声（只保留中文配音）；0.3=原声作为背景音轻微保留"
            )
            vocal_separation = gr.Checkbox(
                label="AI 人声分离（保留 BGM/环境音，商业版）",
                value=False,
                info="建议将原声音量设为 0。本地版仅预留入口不执行；商业版：有独显→本地 GPU；"
                     "无独显→云端 API（或 CPU 回退，较慢）",
            )
            source_video_dir = gr.Textbox(
                label="原视频文件夹（放置你自行下载好的原视频，时长匹配的会自动合并）",
                value=dub8.SOURCE_VIDEO_DIR
            )

            run_btn = gr.Button("开始处理", variant="primary")
            stop_btn = gr.Button("停止")

            gr.Markdown("---")
            gr.Markdown("**批量合并**：扫描输出文件夹中的配音音频，"
                        "在原视频文件夹中按时长+文件名相似度匹配并逐一合并（文件名开头/结尾不必完全一致）。")
            auto_upload = gr.Checkbox(
                label="合并后自动投稿B站（按转载投稿，需先配置bilibili_upload.py中的cookies，"
                      "请确保内容来源合法、有授权）",
                value=False
            )
            bilibili_charging = gr.Checkbox(
                label="更多设置 → 充电设置（情感类塔罗/占卜加入充电合集）",
                value=dub8.BILIBILI_CHARGING_ENABLED,
                info="勾选：加入《充电塔罗占卜翻译&配音》；未勾选：加入《免费塔罗占卜配音》。",
            )
            confirm_before_merge = gr.Checkbox(
                label="合并前先确认匹配结果（可手动修正配错的音视频）",
                value=False
            )
            shutdown_after = gr.Checkbox(
                label="完成后自动关机（任务全部结束后倒计时60秒关机，可在弹出的命令行用 shutdown /a 取消）",
                value=False
            )
            merge_btn = gr.Button("批量合并音频与原视频")
            with gr.Group():
                merge_confirm_title = gr.Markdown(
                    "**请检查下方匹配结果**：勾选「合并」列选择要处理的音频（未勾选的跳过）；"
                    "「匹配的视频」列可直接编辑文件名，或用下方选择器选好后点「配对选中」写入。",
                    visible=False,
                )
                merge_preview = gr.Dataframe(
                    headers=["合并", "配音音频", "匹配的视频"],
                    datatype=["bool", "str", "str"],
                    interactive=True,
                    visible=False,
                )
                with gr.Row(visible=False) as merge_pair_row:
                    merge_audio_sel = gr.Radio(
                        choices=[], label="① 选择音频文件", scale=3)
                    merge_video_sel = gr.Dropdown(
                        choices=[], label="② 选择匹配的视频", scale=3, allow_custom_value=True)
                    merge_pair_btn = gr.Button("配对选中 →", scale=1, variant="secondary")
                merge_confirm_btn = gr.Button("确认并开始合并", variant="primary", visible=False)
            upload_btn = gr.Button("上传已合并视频到B站")
            with gr.Group():
                upload_select = gr.CheckboxGroup(
                    choices=[], value=[],
                    label="选择要上传的视频（取消勾选可排除）",
                    visible=False,
                )
                upload_extra_files = gr.File(
                    label="额外选择视频文件（不在上方列表中的也可以，没有简介/标签信息时留空使用默认值）",
                    file_count="multiple",
                    visible=False,
                )
                upload_confirm_btn = gr.Button("确认并上传", variant="primary", visible=False)

        with gr.Column(scale=2):
            log_box = gr.Textbox(label="运行日志", lines=30, max_lines=30, autoscroll=True)

    def _hide_merge_preview():
        # outputs: title, preview, pair_row, audio_sel, video_sel, confirm_btn
        return (
            gr.update(visible=False),
            gr.update(value=[], visible=False),
            gr.update(visible=False),
            gr.update(choices=[], value=None),
            gr.update(choices=[], value=None),
            gr.update(visible=False),
        )

    def _show_merge_preview(rows, audio_choices, video_choices):
        rows = sanitize_for_gradio(rows)
        audio_choices = sanitize_for_gradio(audio_choices)
        video_choices = sanitize_for_gradio(video_choices)
        return (
            gr.update(visible=True),
            gr.update(value=rows, visible=True),
            gr.update(visible=True),
            gr.update(choices=audio_choices, value=audio_choices[0] if audio_choices else None),
            gr.update(choices=video_choices, value=None),
            gr.update(visible=True),
        )

    def check_playlist(links_text):
        lines = [l.strip() for l in links_text.splitlines() if l.strip()]
        for i, url in enumerate(lines):
            single_url, playlist_url = dub8.parse_playlist_link(url)
            if playlist_url:
                return (
                    gr.update(
                        value=f"该链接属于播放列表：\n{playlist_url}\n\n"
                              "选择只下载当前视频，还是展开整个播放列表？",
                        visible=True,
                    ),
                    gr.update(visible=True),
                    gr.update(visible=True),
                    {'line_index': i, 'single_url': single_url, 'playlist_url': playlist_url}
                )
        return (
            gr.update(value="未检测到播放列表链接。", visible=False),
            gr.update(visible=False),
            gr.update(visible=False),
            None,
        )

    def confirm_playlist(links_text, choice, state):
        if not state:
            return links_text, gr.update(visible=False), gr.update(visible=False), gr.update(visible=False)

        lines = [l.strip() for l in links_text.splitlines() if l.strip()]
        i = state['line_index']

        if choice == "下载整个播放列表":
            try:
                urls = dub8.get_playlist_video_urls(state['playlist_url'])
            except Exception as e:
                return links_text, gr.update(visible=False), gr.update(visible=False), gr.update(visible=False)
            if urls:
                lines = lines[:i] + urls + lines[i+1:]
        else:
            lines[i] = state['single_url']

        new_links = '\n'.join(lines)
        # 性别由"男声序号"输入框决定，与链接数量解耦，这里不需要再动它
        return (
            new_links,
            gr.update(visible=False), gr.update(visible=False), gr.update(visible=False),
        )

    check_playlist_btn.click(
        fn=check_playlist,
        inputs=[links_box],
        outputs=[playlist_msg, playlist_choice, playlist_confirm_btn, playlist_state],
    )

    playlist_confirm_btn.click(
        fn=confirm_playlist,
        inputs=[links_box, playlist_choice, playlist_state],
        outputs=[links_box, playlist_msg, playlist_choice, playlist_confirm_btn],
    )

    run_event = run_btn.click(
        fn=run_pipeline,
        inputs=[links_box, male_nums_box, subtitle_mode, bilingual, male_voice, female_voice, target_lang,
                original_volume, vocal_separation, source_video_dir, bilibili_charging],
        outputs=log_box,
    )
    stop_btn.click(fn=None, inputs=None, outputs=None, cancels=[run_event])

    def run_batch_merge(subtitle_mode, source_video_dir, auto_upload, bilibili_charging, confirm_before_merge,
                        shutdown_flag):
        dub8.SUBTITLE_MODE = subtitle_mode
        dub8.AUTO_UPLOAD_BILIBILI = auto_upload
        dub8.BILIBILI_CHARGING_ENABLED = bool(bilibili_charging)
        if source_video_dir.strip():
            dub8.SOURCE_VIDEO_DIR = source_video_dir.strip()

        if confirm_before_merge:
            video_choices = dub8.list_video_candidates(dub8.OUTPUT_DIR, dub8.SOURCE_VIDEO_DIR)
            rows = dub8.preview_merge_matches(dub8.OUTPUT_DIR, dub8.SOURCE_VIDEO_DIR)
            if not rows:
                yield "未找到配音音频文件。", *_hide_merge_preview()
                return
            audio_choices = [r[1] for r in rows]
            yield (
                "已生成匹配预览，请检查下方表格后点击「确认并开始合并」。",
                *_show_merge_preview(rows, audio_choices, video_choices),
            )
            return

        # 流式显示合并进度
        for text, result in stream_call(
                dub8.batch_merge_videos, dub8.OUTPUT_DIR, dub8.SOURCE_VIDEO_DIR, subtitle_mode):
            if result is None:
                yield text, *_hide_merge_preview()
            else:
                final = (text + "\n\n" + '\n'.join(result) + "\n\n✅ 全部合并结束。"
                         + schedule_shutdown(shutdown_flag))
                notify_done("批量合并完成", "音视频合并已全部完成。")
                yield sanitize_for_gradio(final), *_hide_merge_preview()

    merge_btn.click(
        fn=run_batch_merge,
        inputs=[subtitle_mode, source_video_dir, auto_upload, bilibili_charging, confirm_before_merge,
                shutdown_after],
        outputs=[log_box, merge_confirm_title, merge_preview, merge_pair_row,
                 merge_audio_sel, merge_video_sel, merge_confirm_btn],
    )

    def run_confirmed_merge(subtitle_mode, source_video_dir, auto_upload, bilibili_charging, preview_rows,
                            shutdown_flag):
        dub8.SUBTITLE_MODE = subtitle_mode
        dub8.AUTO_UPLOAD_BILIBILI = auto_upload
        dub8.BILIBILI_CHARGING_ENABLED = bool(bilibili_charging)
        if source_video_dir.strip():
            dub8.SOURCE_VIDEO_DIR = source_video_dir.strip()
        pairs = preview_rows.values.tolist() if hasattr(preview_rows, 'values') else preview_rows
        for text, result in stream_call(
                dub8.batch_merge_videos, dub8.OUTPUT_DIR, dub8.SOURCE_VIDEO_DIR,
                subtitle_mode, pairs=pairs):
            if result is None:
                yield text, *_hide_merge_preview()
            else:
                final = (text + "\n\n" + '\n'.join(result) + "\n\n✅ 全部合并结束。"
                         + schedule_shutdown(shutdown_flag))
                notify_done("批量合并完成", "音视频合并已全部完成。")
                yield sanitize_for_gradio(final), *_hide_merge_preview()

    merge_confirm_btn.click(
        fn=run_confirmed_merge,
        inputs=[subtitle_mode, source_video_dir, auto_upload, bilibili_charging, merge_preview, shutdown_after],
        outputs=[log_box, merge_confirm_title, merge_preview, merge_pair_row,
                 merge_audio_sel, merge_video_sel, merge_confirm_btn],
    )

    def pair_audio_video(audio_choice, video_choice, current_df):
        """把选中的音频与视频在表格中配对（列：合并(bool), 音频, 视频）"""
        if not audio_choice or not video_choice:
            return current_df
        rows = current_df.values.tolist() if hasattr(current_df, 'values') else list(current_df)
        for row in rows:
            if row and len(row) >= 3 and row[1] == audio_choice:
                row[2] = video_choice
                row[0] = True  # 手动配对后自动勾选该行
                break
        return rows

    merge_pair_btn.click(
        fn=pair_audio_video,
        inputs=[merge_audio_sel, merge_video_sel, merge_preview],
        outputs=[merge_preview],
    )

    def show_upload_list():
        files = [sanitize_for_gradio(f) for f in dub8.list_uploadable_videos(dub8.OUTPUT_DIR)]
        if not files:
            return (
                sanitize_for_gradio(f"{dub8.OUTPUT_DIR} 中没有找到已合并的视频（*_dubbed.mp4）"),
                gr.update(choices=[], value=[], visible=False),
                gr.update(visible=False),
                gr.update(visible=False),
            )
        return (
            "请勾选要上传的视频，确认后点击「确认并上传」。",
            gr.update(choices=files, value=files, visible=True),
            gr.update(visible=True),
            gr.update(visible=True),
        )

    upload_btn.click(
        fn=show_upload_list,
        inputs=[],
        outputs=[log_box, upload_select, upload_extra_files, upload_confirm_btn],
    )

    def run_confirmed_upload(selected_files, extra_files, bilibili_charging, shutdown_flag):
        dub8.BILIBILI_CHARGING_ENABLED = bool(bilibili_charging)
        extra_paths = [f.name if hasattr(f, 'name') else f for f in (extra_files or [])]
        # 流式显示上传进度（含每个分片的百分比/速度/ETA，由 bilibili_upload 内打印）
        # 上传开始后立即隐藏选择/确认控件，避免它们各自显示一个"处理中"转圈，只在日志处保留一个。
        for text, result in stream_call(
                dub8.upload_selected_videos, dub8.OUTPUT_DIR, selected_files, extra_paths):
            if result is None:
                yield (sanitize_for_gradio(text),
                       gr.update(visible=False), gr.update(visible=False), gr.update(visible=False))
            else:
                final = text + "\n\n" + '\n'.join(result) + "\n\n✅ 全部上传结束。"
                final += schedule_shutdown(shutdown_flag)
                notify_done("批量投稿完成", "B站投稿已全部结束。")
                yield (sanitize_for_gradio(final),
                       gr.update(visible=False), gr.update(visible=False), gr.update(visible=False))

    upload_confirm_btn.click(
        fn=run_confirmed_upload,
        inputs=[upload_select, upload_extra_files, bilibili_charging, shutdown_after],
        outputs=[log_box, upload_select, upload_extra_files, upload_confirm_btn],
    )

    def check_resume():
        state = load_run_state()
        if not state:
            return gr.update(visible=False), ""
        links = [l.strip() for l in state.get('links_text', '').splitlines() if l.strip()]
        msg = (f"检测到上次未完成的任务（{len(links)}个链接），是否继续？\n\n"
               "点击「继续上次任务」会自动填入上次的链接和配置——"
               "已经生成过配音的视频会自动跳过，只续做未完成的部分。")
        return gr.update(visible=True), msg

    demo.load(
        fn=check_resume,
        inputs=[],
        outputs=[resume_group, resume_msg],
    )

    def do_resume():
        state = load_run_state()
        if not state:
            return [gr.update()] * 11
        links_text = state.get('links_text', '')
        # 优先恢复"男声序号"；老存档没有就从 genders_text 反推出男声序号
        male_nums = state.get('male_nums_text')
        if male_nums is None:
            old_g = [g.strip() for g in state.get('genders_text', '').splitlines() if g.strip()]
            male_nums = ','.join(str(i + 1) for i, g in enumerate(old_g) if g == '男')
        return (
            gr.update(value=links_text),
            gr.update(value=male_nums),
            gr.update(value=state.get('subtitle_mode', 'none')),
            gr.update(value=state.get('bilingual', False)),
            gr.update(value=state.get('male_voice', dub8.MALE_VOICES[0])),
            gr.update(value=state.get('female_voice', dub8.FEMALE_VOICES[0])),
            gr.update(value=state.get('target_lang', dub8.TARGET_LANG)),
            gr.update(value=state.get('original_volume', dub8.ORIGINAL_AUDIO_VOLUME)),
            gr.update(value=state.get(
                'vocal_separation', state.get('keep_bg_when_muted', False))),
            gr.update(value=state.get('source_video_dir', dub8.SOURCE_VIDEO_DIR)),
            gr.update(visible=False),
        )

    resume_btn.click(
        fn=do_resume,
        inputs=[],
        outputs=[links_box, male_nums_box, subtitle_mode, bilingual, male_voice, female_voice,
                 target_lang, original_volume, vocal_separation, source_video_dir, resume_group],
    )

    dismiss_resume_btn.click(
        fn=lambda: gr.update(visible=False),
        inputs=[],
        outputs=[resume_group],
    )


if __name__ == '__main__':
    # 让 127.0.0.1/localhost 绕过系统代理：否则 Gradio 启动后的自检请求会被代理拦截，
    # 报 "When localhost is not accessible, a shareable link must be created"。
    for _k in ('no_proxy', 'NO_PROXY'):
        _cur = os.environ.get(_k, '')
        if '127.0.0.1' not in _cur or 'localhost' not in _cur:
            os.environ[_k] = (_cur + ',' if _cur else '') + '127.0.0.1,localhost'

    dub8.refresh_cookies_from_browser()
    dub8.refresh_bilibili_cookies()
    demo.launch(server_name='127.0.0.1', server_port=7860, inbrowser=True)
