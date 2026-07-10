# dub10.py - 匀速配音版本

## 核心改进：全程匀速配音

**目标**：解决现有配音系统"一会儿快一会儿慢"的问题，实现录音棚级别的匀速听感。

---

## 主要改动

### 1. ✨ 新增：全局速率计算 `calculate_base_rate()`

```python
def calculate_base_rate(segments, target_chars_per_sec=3.2)
```

**原理**：
- 统计整个视频的中文字数和总时长
- 计算平均字/秒
- 根据目标语速（中文标准 3.2 字/秒）计算需要的 TTS 速率偏移

**例子**：
```
1000 字 / 100 秒 = 10 字/秒
需要快 212% → rate = +212%（全视频统一）
```

**输出示例**：
```
📊 速率计算: 1000 字 / 100.0秒 = 10.00 字/秒
   目标: 3.2 字/秒 → 基准速率: +212%
```

---

### 2. 🔧 改进：删除单句微调逻辑

**原问题**：
- 每个句子都独立判断"是否超时"
- 超时则加速该句 → 导致有些句子 100%，有些 130%
- 听感不稳定

**改进后**：
- 所有句子用**同一个 base_rate_pct**
- 真正的全程匀速
- 注释更新，说明"不再做单句微调"

---

### 3. 🎯 新增：后期处理 `post_process_overlong_segments()`

用于处理仍然超时的少数句子（不用重新 TTS，而是时间伸缩）。

**原理**：
- 检查每个句子的实际时长 vs 时间窗
- 对于超时的句子，用 ffmpeg 的 `atempo` 滤镜做时间伸缩（不变调）
- 相当于在录音机上拧快进，听起来自然而不刺耳

**优点**：
- ✅ 无需重新调用 TTS（省成本）
- ✅ 保持自然音质（不是加速导致的变调）
- ✅ 完全局部处理（不影响其他句子）

**输出示例**：
```
⚠️  后期处理：3 个句子超时，已尝试时间伸缩
    1. "这是一个很长的句子..." 超 0.35s ✓ 时间伸缩成功
    2. "另一个句子..." 超 0.12s ✓ 时间伸缩成功
    3. ...
```

---

### 4. 🔗 集成：调用链路

**原流程**：
```
parse subtitles → translate → synthesize_all()
```

**新流程**：
```
parse subtitles → translate 
    ↓
calculate_base_rate()  ← 计算全局速率
    ↓
synthesize_all(base_rate_pct)  ← 所有句子用同一速率
    ↓
post_process_overlong_segments()  ← 后期补救超时的句子
```

---

## 配置调整

### 主动调控：目标语速

在 `calculate_base_rate()` 中修改 `target_chars_per_sec` 参数：

```python
# 标准配置（中文）
base_rate_pct = calculate_base_rate(segments, target_chars_per_sec=3.2)

# 想要更慢（2.8 字/秒）
base_rate_pct = calculate_base_rate(segments, target_chars_per_sec=2.8)

# 想要更快（3.6 字/秒）
base_rate_pct = calculate_base_rate(segments, target_chars_per_sec=3.6)
```

### 后期处理容差

在 `post_process_overlong_segments()` 中调整：

```python
# 默认：允许超 5% 或 0.2 秒
await post_process_overlong_segments(segments, tolerance_ratio=1.05, tolerance_sec=0.2)

# 更严格：允许超 2% 或 0.1 秒
await post_process_overlong_segments(segments, tolerance_ratio=1.02, tolerance_sec=0.1)

# 更宽松：允许超 10%
await post_process_overlong_segments(segments, tolerance_ratio=1.10, tolerance_sec=0.3)
```

---

## 依赖项

- **ffmpeg**（仅用于后期处理超时句子）
  - 如果没有 ffmpeg，后期处理会自动跳过，不影响主流程
  - 推荐安装：`choco install ffmpeg` 或 `winget install ffmpeg`

- **librosa/soundfile**（已备选，暂未启用）
  - 如果后续要用 librosa 的 time_stretch，需装这两个

---

## 测试建议

1. **对比测试**：用同一个视频
   - dub9.py（原版）：逐句微调，会听出"一会儿快一会儿慢"
   - dub10.py（新版）：全程匀速

2. **边界测试**：
   - 字数密集视频（如讲座、新闻）→ base_rate_pct 会很高
   - 字数稀疏视频（如品酒、旅游 vlog）→ base_rate_pct 会低或负数

3. **超时句子**：
   - 主要的超时补救应该交给后期处理
   - 如果后期处理失败，可考虑手动调整字幕端点（拉长时间窗）

---

## 性能影响

| 项目 | 改进 |
|------|------|
| TTS 调用次数 | **↓ 减少**（不再重新生成超时句子） |
| 总处理时间 | **→ 基本不变**（后期处理很快） |
| 音质 | **↑ 提升**（time_stretch 优于 TTS 加速） |
| 听感 | **↑ 显著提升**（全程真正匀速） |

---

## 故障排查

### Q: 后期处理报错"ffmpeg 调用失败"
**A**: 检查 ffmpeg 是否安装
```bash
ffmpeg -version  # 应该输出版本号
```
如果没装，可选装或忽略（配音仍会工作，只是超时的句子不自动补救）。

### Q: 整个视频都在加速状态（base_rate_pct 很高）
**A**: 这是正常的。说明字数多、时间短。可以：
1. 调长时间窗（编辑字幕的 end 时间）
2. 选择不同的 target_chars_per_sec（更慢的目标语速）

### Q: 后期处理仍有句子未修复
**A**: 这些句子的超时超出了 atempo 的能力范围（>2x）。需要手动调整：
1. 删掉一些冗余的中文词
2. 拉长字幕时间窗
3. 或考虑这一句接受"快一点"

---

## 后续优化方向

1. **智能目标语速**：根据视频类型自动选择目标语速
   - 讲座/教学 → 3.0 字/秒（慢一点）
   - 新闻/报道 → 3.5 字/秒
   - 故事/叙述 → 3.2 字/秒（中等）

2. **韵律优化**：加入呼吸、停顿、强调
   - 句末短暂停顿
   - 关键词前加强调

3. **多人配音协调**：不同配音员也保持相同的 base_rate_pct

---

## 文件变更统计

- **新增函数**：3 个
  - `calculate_base_rate()`
  - `stretch_audio_with_ffmpeg()`
  - `post_process_overlong_segments()`

- **删除代码**：~25 行（单句微调逻辑）

- **总行数**：2785（vs dub9.py 的 2600+）

---

## 使用指南

### 快速开始

```python
# 直接运行，无需改配置
python dub10.py <YouTube_URL>
```

### 自定义语速

编辑代码中调用 `calculate_base_rate()` 的部分：

```python
# 第 1776 行附近
base_rate_pct = calculate_base_rate(segments, target_chars_per_sec=3.2)
# 改为：
base_rate_pct = calculate_base_rate(segments, target_chars_per_sec=3.0)  # 更慢
```

### 禁用后期处理

```python
# 注释掉这一行（第 1458 行附近）
# await post_process_overlong_segments(segments)
```

---

**最后**：这是一个"实时匀速配音"的成熟方案，既保证了听感的一致性，又避免了复杂的多轮 API 调用。祝测试顺利！🎯
