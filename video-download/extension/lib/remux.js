(function (root) {
  const VD = root.__vd || (root.__vd = {});

  const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];

  function concat(parts) {
    let length = 0;
    for (const part of parts) length += part.byteLength;
    const out = new Uint8Array(length);
    let offset = 0;
    for (const part of parts) {
      out.set(part, offset);
      offset += part.byteLength;
    }
    return out;
  }

  class BitReader {
    constructor(bytes) {
      this.bytes = bytes;
      this.bit = 0;
    }

    u(count) {
      let value = 0;
      for (let i = 0; i < count; i++) {
        const index = this.bit >> 3;
        if (index >= this.bytes.length) return value;
        const shift = 7 - (this.bit & 7);
        value = (value << 1) | ((this.bytes[index] >> shift) & 1);
        this.bit++;
      }
      return value;
    }

    ue() {
      let zeros = 0;
      while (this.u(1) === 0 && zeros < 32) zeros++;
      if (zeros === 0) return 0;
      return ((1 << zeros) | this.u(zeros)) - 1;
    }

    se() {
      const value = this.ue();
      return (value & 1) ? ((value + 1) >> 1) : -(value >> 1);
    }
  }

  function unescapeRbsp(bytes) {
    const out = [];
    for (let i = 0; i < bytes.length; i++) {
      if (i + 2 < bytes.length && bytes[i] === 0 && bytes[i + 1] === 0 && bytes[i + 2] === 3) {
        out.push(0, 0);
        i += 2;
      } else {
        out.push(bytes[i]);
      }
    }
    return Uint8Array.from(out);
  }

  function skipScalingList(reader, size) {
    let last = 8;
    let next = 8;
    for (let i = 0; i < size; i++) {
      if (next !== 0) {
        const delta = reader.se();
        next = (last + delta + 256) % 256;
      }
      last = next === 0 ? last : next;
    }
  }

  function parseSps(nal) {
    const reader = new BitReader(unescapeRbsp(nal.subarray(1)));
    const profile = reader.u(8);
    reader.u(8);
    reader.u(8);
    reader.ue();
    let chroma = 1;
    if ([100, 110, 122, 244, 44, 83, 86, 118, 128, 138, 139, 134, 135].includes(profile)) {
      chroma = reader.ue();
      if (chroma === 3) reader.u(1);
      reader.ue();
      reader.ue();
      reader.u(1);
      if (reader.u(1)) {
        const count = chroma === 3 ? 12 : 8;
        for (let i = 0; i < count; i++) {
          if (reader.u(1)) skipScalingList(reader, i < 6 ? 16 : 64);
        }
      }
    }
    reader.ue();
    const pocType = reader.ue();
    if (pocType === 0) {
      reader.ue();
    } else if (pocType === 1) {
      reader.u(1);
      reader.se();
      reader.se();
      const cycles = reader.ue();
      for (let i = 0; i < cycles; i++) reader.se();
    }
    reader.ue();
    reader.u(1);
    const widthInMbs = reader.ue() + 1;
    const heightInMaps = reader.ue() + 1;
    const frameMbsOnly = reader.u(1);
    if (!frameMbsOnly) reader.u(1);
    reader.u(1);
    let cropLeft = 0;
    let cropRight = 0;
    let cropTop = 0;
    let cropBottom = 0;
    if (reader.u(1)) {
      cropLeft = reader.ue();
      cropRight = reader.ue();
      cropTop = reader.ue();
      cropBottom = reader.ue();
    }
    const cropUnitX = chroma === 1 || chroma === 2 ? 2 : 1;
    const cropUnitY = (chroma === 1 ? 2 : 1) * (2 - frameMbsOnly);
    const width = widthInMbs * 16 - (cropLeft + cropRight) * cropUnitX;
    const height = heightInMaps * 16 * (2 - frameMbsOnly) - (cropTop + cropBottom) * cropUnitY;
    return { width, height };
  }

  function splitNals(elementary) {
    const marks = [];
    for (let i = 0; i + 3 < elementary.length; i++) {
      if (elementary[i] !== 0 || elementary[i + 1] !== 0 || elementary[i + 2] !== 1) continue;
      const startCode = i > 0 && elementary[i - 1] === 0 ? i - 1 : i;
      const previous = marks[marks.length - 1];
      if (previous && previous.startCode === startCode) continue;
      marks.push({ startCode, nal: i + 3 });
    }
    const nals = [];
    for (let i = 0; i < marks.length; i++) {
      const begin = marks[i].nal;
      const end = i + 1 < marks.length ? marks[i + 1].startCode : elementary.length;
      if (end > begin) nals.push(elementary.subarray(begin, end));
    }
    return nals;
  }

  function nalType(nal) {
    return nal.length ? nal[0] & 0x1f : 0;
  }

  function accessUnitToAvcc(nals) {
    const parts = [];
    let key = false;
    for (const nal of nals) {
      const type = nalType(nal);
      if (type === 9 || type === 12 || type === 0) continue;
      if (type === 5) key = true;
      const length = new Uint8Array(4);
      new DataView(length.buffer).setUint32(0, nal.length);
      parts.push(length, nal);
    }
    return { data: parts.length ? concat(parts) : new Uint8Array(0), key };
  }

  function readTimestamp(bytes, offset) {
    return ((bytes[offset] & 0x0e) * 536870912)
      + (bytes[offset + 1] * 4194304)
      + ((bytes[offset + 2] & 0xfe) * 16384)
      + (bytes[offset + 3] * 128)
      + ((bytes[offset + 4] & 0xfe) / 2);
  }

  function parsePes(payload) {
    if (payload.length < 9 || payload[0] !== 0 || payload[1] !== 0 || payload[2] !== 1) return null;
    const streamId = payload[3];
    const flags = payload[7];
    const headerLength = payload[8];
    let offset = 9;
    let pts = null;
    let dts = null;
    if (flags & 0x80) {
      if (offset + 5 > payload.length) return null;
      pts = readTimestamp(payload, offset);
      offset += 5;
    }
    if (flags & 0x40) {
      if (offset + 5 > payload.length) return null;
      dts = readTimestamp(payload, offset);
    }
    const bodyStart = 9 + headerLength;
    if (bodyStart > payload.length) return null;
    return {
      streamId,
      pts,
      dts: dts == null ? pts : dts,
      body: payload.subarray(bodyStart),
    };
  }

  function splitAdts(buffer) {
    const frames = [];
    let header = null;
    let index = 0;
    while (index + 7 <= buffer.length) {
      if (buffer[index] !== 0xff || (buffer[index + 1] & 0xf0) !== 0xf0) {
        index++;
        continue;
      }
      const protectionAbsent = buffer[index + 1] & 1;
      const headerLength = protectionAbsent ? 7 : 9;
      const frameLength = ((buffer[index + 3] & 3) << 11) | (buffer[index + 4] << 3) | ((buffer[index + 5] & 0xe0) >> 5);
      if (frameLength < headerLength) {
        index++;
        continue;
      }
      if (index + frameLength > buffer.length) break;
      if (!header) header = buffer.subarray(index, index + 7);
      frames.push(buffer.subarray(index + headerLength, index + frameLength));
      index += frameLength;
    }
    return { frames, leftover: buffer.subarray(index), header };
  }

  function audioSpecificConfig(adtsHeader) {
    const profile = ((adtsHeader[2] & 0xc0) >> 6) + 1;
    const frequencyIndex = (adtsHeader[2] & 0x3c) >> 2;
    const channels = ((adtsHeader[2] & 1) << 2) | ((adtsHeader[3] & 0xc0) >> 6);
    const bits = (profile << 11) | (frequencyIndex << 7) | (channels << 3);
    return {
      bytes: Uint8Array.of((bits >> 8) & 0xff, bits & 0xff),
      sampleRate: SAMPLE_RATES[frequencyIndex] || 48000,
      channels: channels || 2,
      frequencyIndex,
    };
  }

  function parsePmt(section) {
    const sectionLength = ((section[1] & 0x0f) << 8) | section[2];
    const infoLength = ((section[10] & 0x0f) << 8) | section[11];
    let offset = 12 + infoLength;
    const end = Math.min(section.length, 3 + sectionLength - 4);
    let videoPid = null;
    let audioPid = null;
    let audioType = null;
    while (offset + 5 <= end) {
      const streamType = section[offset];
      const pid = ((section[offset + 1] & 0x1f) << 8) | section[offset + 2];
      const esLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];
      if (streamType === 0x1b && videoPid == null) videoPid = pid;
      if ((streamType === 0x0f || streamType === 0x11) && audioPid == null) {
        audioPid = pid;
        audioType = streamType;
      }
      offset += 5 + esLength;
    }
    return { videoPid, audioPid, audioType };
  }

  class TsDemuxer {
    constructor() {
      this.videoPid = null;
      this.audioPid = null;
      this.audioType = 0x0f;
      this.open = new Map();
      this.audioCarry = new Uint8Array(0);
      this.videoSamples = [];
      this.audioFrames = [];
      this.sps = null;
      this.pps = null;
      this.audioConfig = null;
      this.audioStartPts = null;
    }

    push(bytes) {
      const data = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
      let index = 0;
      while (index + 188 <= data.length) {
        if (data[index] !== 0x47) {
          index++;
          continue;
        }
        this.consumePacket(data.subarray(index, index + 188));
        index += 188;
      }
      for (const pid of [...this.open.keys()]) this.finishPes(pid);
    }

    consumePacket(packet) {
      const pid = ((packet[1] & 0x1f) << 8) | packet[2];
      const start = (packet[1] & 0x40) !== 0;
      const adaptation = (packet[3] >> 4) & 3;
      let offset = 4;
      if (adaptation & 2) {
        offset += 1 + packet[offset];
        if (offset > 188) return;
      }
      if ((adaptation & 1) === 0 || offset >= 188) return;
      const payload = packet.subarray(offset);
      if (!payload.length) return;

      if (start && payload[0] === 0 && payload[1] === 0 && payload[2] === 1) {
        this.finishPes(pid);
        this.open.set(pid, [payload]);
        return;
      }
      if (this.open.has(pid)) {
        this.open.get(pid).push(payload);
        return;
      }
      if (!start) return;
      const pointer = payload[0];
      const section = payload.subarray(1 + pointer);
      if (section[0] === 2) {
        const pmt = parsePmt(section);
        if (pmt.videoPid != null) this.videoPid = pmt.videoPid;
        if (pmt.audioPid != null) {
          this.audioPid = pmt.audioPid;
          this.audioType = pmt.audioType;
        }
      }
    }

    finishPes(pid) {
      const chunks = this.open.get(pid);
      if (!chunks) return;
      this.open.delete(pid);
      const pes = parsePes(concat(chunks));
      if (!pes || pes.pts == null) return;
      const streamId = pes.streamId;
      const isVideo = pid === this.videoPid || (this.videoPid == null && streamId >= 0xe0 && streamId <= 0xef);
      const isAudio = pid === this.audioPid || (this.audioPid == null && streamId >= 0xc0 && streamId <= 0xdf);
      if (isVideo) {
        if (this.videoPid == null) this.videoPid = pid;
        this.addVideo(pes);
      } else if (isAudio) {
        if (this.audioPid == null) this.audioPid = pid;
        this.addAudio(pes);
      }
    }

    addVideo(pes) {
      const nals = splitNals(pes.body);
      for (const nal of nals) {
        const type = nalType(nal);
        if (type === 7 && !this.sps) this.sps = nal.slice();
        if (type === 8 && !this.pps) this.pps = nal.slice();
      }
      const sample = accessUnitToAvcc(nals);
      if (!sample.data.length) return;
      this.videoSamples.push({
        dts: pes.dts,
        pts: pes.pts,
        key: sample.key,
        data: sample.data,
      });
    }

    addAudio(pes) {
      if (this.audioType === 0x11) return;
      const merged = this.audioCarry.length ? concat([this.audioCarry, pes.body]) : pes.body;
      const split = splitAdts(merged);
      this.audioCarry = split.leftover.length && split.leftover.length < 4096
        ? split.leftover.slice()
        : new Uint8Array(0);
      if (split.header && !this.audioConfig) this.audioConfig = audioSpecificConfig(split.header);
      if (this.audioStartPts == null) this.audioStartPts = pes.pts;
      for (const frame of split.frames) {
        if (!frame.length) continue;
        this.audioFrames.push(frame.slice());
      }
    }
  }

  class Bin {
    constructor() {
      this.parts = [];
      this.length = 0;
    }

    bytes(value) {
      this.parts.push(value);
      this.length += value.byteLength;
    }

    u8(value) {
      this.bytes(Uint8Array.of(value & 0xff));
    }

    u16(value) {
      const bytes = new Uint8Array(2);
      new DataView(bytes.buffer).setUint16(0, value);
      this.bytes(bytes);
    }

    u32(value) {
      const bytes = new Uint8Array(4);
      new DataView(bytes.buffer).setUint32(0, value >>> 0);
      this.bytes(bytes);
    }

    u64(value) {
      const big = BigInt(value);
      this.u32(Number(big >> 32n));
      this.u32(Number(big & 0xffffffffn));
    }

    i64(value) {
      let big = BigInt(value);
      if (big < 0n) big = (1n << 64n) + big;
      this.u64(big);
    }

    str(value) {
      this.bytes(new TextEncoder().encode(value));
    }

    zeros(count) {
      this.bytes(new Uint8Array(count));
    }

    box(type, fill) {
      const inner = new Bin();
      fill(inner);
      const payload = inner.toUint8();
      this.u32(payload.length + 8);
      this.str(type);
      this.bytes(payload);
    }

    toUint8() {
      const out = new Uint8Array(this.length);
      let offset = 0;
      for (const part of this.parts) {
        out.set(part, offset);
        offset += part.byteLength;
      }
      return out;
    }
  }

  function u32Table(values) {
    const out = new Uint8Array(values.length * 4);
    const view = new DataView(out.buffer);
    for (let i = 0; i < values.length; i++) view.setUint32(i * 4, values[i] >>> 0);
    return out;
  }

  function u64Table(values) {
    const out = new Uint8Array(values.length * 8);
    const view = new DataView(out.buffer);
    for (let i = 0; i < values.length; i++) {
      const big = BigInt(values[i]);
      view.setUint32(i * 8, Number(big >> 32n));
      view.setUint32(i * 8 + 4, Number(big & 0xffffffffn));
    }
    return out;
  }

  function runLength(values) {
    const runs = [];
    for (const value of values) {
      const last = runs[runs.length - 1];
      if (last && last.value === value) last.count++;
      else runs.push({ count: 1, value });
    }
    return runs;
  }

  function mode(values) {
    const counts = new Map();
    let best = values[0] || 3000;
    let bestCount = 0;
    for (const value of values) {
      const count = (counts.get(value) || 0) + 1;
      counts.set(value, count);
      if (count > bestCount) {
        best = value;
        bestCount = count;
      }
    }
    return best;
  }

  function ftyp() {
    const bin = new Bin();
    bin.box("ftyp", (box) => {
      box.str("isom");
      box.u32(0x200);
      box.str("isom");
      box.str("iso2");
      box.str("avc1");
      box.str("mp41");
    });
    return bin.toUint8();
  }

  function mdatHeader(totalSize) {
    const bytes = new Uint8Array(16);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 1);
    bytes.set([0x6d, 0x64, 0x61, 0x74], 4);
    const big = BigInt(totalSize);
    view.setUint32(8, Number(big >> 32n));
    view.setUint32(12, Number(big & 0xffffffffn));
    return bytes;
  }

  function descriptor(tag, body) {
    const out = new Uint8Array(2 + body.length);
    out[0] = tag;
    out[1] = body.length;
    out.set(body, 2);
    return out;
  }

  function esdsBox(config, avgBitrate) {
    const specific = descriptor(0x05, config);
    const decoderBody = new Uint8Array(13 + specific.length);
    decoderBody[0] = 0x40;
    decoderBody[1] = 0x15;
    decoderBody[2] = 0;
    decoderBody[3] = 0;
    decoderBody[4] = 0;
    new DataView(decoderBody.buffer).setUint32(5, avgBitrate);
    new DataView(decoderBody.buffer).setUint32(9, avgBitrate);
    decoderBody.set(specific, 13);
    const decoder = descriptor(0x04, decoderBody);
    const sl = descriptor(0x06, Uint8Array.of(0x02));
    const esBody = new Uint8Array(3 + decoder.length + sl.length);
    esBody[0] = 0;
    esBody[1] = 0;
    esBody[2] = 0;
    esBody.set(decoder, 3);
    esBody.set(sl, 3 + decoder.length);
    const es = descriptor(0x03, esBody);
    const bin = new Bin();
    bin.box("esds", (box) => {
      box.u32(0);
      box.bytes(es);
    });
    return bin.toUint8();
  }

  function avc1Box(width, height, sps, pps) {
    const avcC = new Bin();
    avcC.box("avcC", (box) => {
      box.u8(1);
      box.u8(sps[1]);
      box.u8(sps[2]);
      box.u8(sps[3]);
      box.u8(0xff);
      box.u8(0xe1);
      box.u16(sps.length);
      box.bytes(sps);
      box.u8(1);
      box.u16(pps.length);
      box.bytes(pps);
    });
    const bin = new Bin();
    bin.box("avc1", (box) => {
      box.zeros(6);
      box.u16(1);
      box.zeros(16);
      box.u16(width);
      box.u16(height);
      box.u32(0x00480000);
      box.u32(0x00480000);
      box.u32(0);
      box.u16(1);
      box.zeros(32);
      box.u16(0x0018);
      box.u16(0xffff);
      box.bytes(avcC.toUint8());
    });
    return bin.toUint8();
  }

  function mp4aBox(sampleRate, channels, config, avgBitrate) {
    const bin = new Bin();
    bin.box("mp4a", (box) => {
      box.zeros(6);
      box.u16(1);
      box.zeros(8);
      box.u16(channels);
      box.u16(16);
      box.u32(0);
      box.u32(sampleRate << 16);
      box.bytes(esdsBox(config, avgBitrate));
    });
    return bin.toUint8();
  }

  function matrix(bin) {
    bin.u32(0x00010000);
    bin.u32(0);
    bin.u32(0);
    bin.u32(0);
    bin.u32(0x00010000);
    bin.u32(0);
    bin.u32(0);
    bin.u32(0);
    bin.u32(0x40000000);
  }

  function hdlr(type, name) {
    const bin = new Bin();
    bin.box("hdlr", (box) => {
      box.u32(0);
      box.u32(0);
      box.str(type);
      box.zeros(12);
      box.str(name);
      box.u8(0);
    });
    return bin.toUint8();
  }

  function dinf() {
    const bin = new Bin();
    bin.box("dinf", (box) => {
      box.box("dref", (dref) => {
        dref.u32(0);
        dref.u32(1);
        dref.box("url ", (url) => {
          url.u32(1);
        });
      });
    });
    return bin.toUint8();
  }

  function sttsConstant(count, delta) {
    const bin = new Bin();
    bin.box("stts", (box) => {
      box.u32(0);
      box.u32(1);
      box.u32(count);
      box.u32(delta);
    });
    return bin.toUint8();
  }

  function sttsBox(deltas) {
    const runs = runLength(deltas);
    const bin = new Bin();
    bin.box("stts", (box) => {
      box.u32(0);
      box.u32(runs.length);
      const table = new Uint8Array(runs.length * 8);
      const view = new DataView(table.buffer);
      runs.forEach((run, index) => {
        view.setUint32(index * 8, run.count);
        view.setInt32(index * 8 + 4, run.value);
      });
      box.bytes(table);
    });
    return bin.toUint8();
  }

  function cttsBox(offsets) {
    if (offsets.every((value) => value === 0)) return null;
    const version = offsets.some((value) => value < 0) ? 1 : 0;
    const runs = runLength(offsets);
    const bin = new Bin();
    bin.box("ctts", (box) => {
      box.u32(version << 24);
      box.u32(runs.length);
      const table = new Uint8Array(runs.length * 8);
      const view = new DataView(table.buffer);
      runs.forEach((run, index) => {
        view.setUint32(index * 8, run.count);
        view.setInt32(index * 8 + 4, run.value);
      });
      box.bytes(table);
    });
    return bin.toUint8();
  }

  function stscBox() {
    const bin = new Bin();
    bin.box("stsc", (box) => {
      box.u32(0);
      box.u32(1);
      box.u32(1);
      box.u32(1);
      box.u32(1);
    });
    return bin.toUint8();
  }

  function stszBox(sizes) {
    const bin = new Bin();
    bin.box("stsz", (box) => {
      box.u32(0);
      box.u32(0);
      box.u32(sizes.length);
      box.bytes(u32Table(sizes));
    });
    return bin.toUint8();
  }

  function stssBox(keys) {
    const bin = new Bin();
    bin.box("stss", (box) => {
      box.u32(0);
      box.u32(keys.length);
      box.bytes(u32Table(keys));
    });
    return bin.toUint8();
  }

  function co64Box(offsets) {
    const bin = new Bin();
    bin.box("co64", (box) => {
      box.u32(0);
      box.u32(offsets.length);
      box.bytes(u64Table(offsets));
    });
    return bin.toUint8();
  }

  function stsdBox(entry) {
    const bin = new Bin();
    bin.box("stsd", (box) => {
      box.u32(0);
      box.u32(1);
      box.bytes(entry);
    });
    return bin.toUint8();
  }

  function mdhd(timescale, duration) {
    const bin = new Bin();
    bin.box("mdhd", (box) => {
      box.u32(1 << 24);
      box.u64(0);
      box.u64(0);
      box.u32(timescale);
      box.u64(duration);
      box.u16(0x55c4);
      box.u16(0);
    });
    return bin.toUint8();
  }

  function tkhd(trackId, duration, width, height, volume) {
    const bin = new Bin();
    bin.box("tkhd", (box) => {
      box.u32((1 << 24) | 7);
      box.u64(0);
      box.u64(0);
      box.u32(trackId);
      box.u32(0);
      box.u64(duration);
      box.zeros(8);
      box.u16(0);
      box.u16(0);
      box.u16(volume);
      box.u16(0);
      matrix(box);
      box.u32(width);
      box.u32(height);
    });
    return bin.toUint8();
  }

  function elst(shift, mediaDuration) {
    if (!shift) return null;
    const bin = new Bin();
    bin.box("edts", (edts) => {
      edts.box("elst", (box) => {
        box.u32(1 << 24);
        box.u32(2);
        box.u64(shift);
        box.i64(-1);
        box.u32(0x00010000);
        box.u64(mediaDuration);
        box.u64(0);
        box.u32(0x00010000);
      });
    });
    return bin.toUint8();
  }

  function videoTrack(meta) {
    const deltas = [];
    for (let i = 0; i < meta.samples.length - 1; i++) {
      const delta = meta.samples[i + 1].dts - meta.samples[i].dts;
      deltas.push(delta > 0 && delta < 450000 ? delta : meta.frameDuration);
    }
    deltas.push(meta.frameDuration);
    const duration = deltas.reduce((sum, value) => sum + value, 0);
    const offsets = meta.samples.map((sample) => sample.pts - sample.dts);
    const keys = [];
    meta.samples.forEach((sample, index) => {
      if (sample.key) keys.push(index + 1);
    });
    if (!keys.length) keys.push(1);
    const shift = meta.shift;
    const movieDuration = duration + shift;
    const bin = new Bin();
    bin.box("trak", (trak) => {
      trak.bytes(tkhd(1, movieDuration, meta.width << 16, meta.height << 16, 0));
      const edit = elst(shift, duration);
      if (edit) trak.bytes(edit);
      trak.box("mdia", (mdia) => {
        mdia.bytes(mdhd(90000, duration));
        mdia.bytes(hdlr("vide", "VideoHandler"));
        mdia.box("minf", (minf) => {
          minf.box("vmhd", (vmhd) => {
            vmhd.u32(1);
            vmhd.u16(0);
            vmhd.u16(0);
            vmhd.u16(0);
            vmhd.u16(0);
          });
          minf.bytes(dinf());
          minf.box("stbl", (stbl) => {
            stbl.bytes(stsdBox(avc1Box(meta.width, meta.height, meta.sps, meta.pps)));
            stbl.bytes(sttsBox(deltas));
            const ctts = cttsBox(offsets);
            if (ctts) stbl.bytes(ctts);
            stbl.bytes(stssBox(keys));
            stbl.bytes(stscBox());
            stbl.bytes(stszBox(meta.samples.map((sample) => sample.size)));
            stbl.bytes(co64Box(meta.samples.map((sample) => sample.offset)));
          });
        });
      });
    });
    return { box: bin.toUint8(), movieDuration };
  }

  function audioTrack(meta) {
    const frameTicks = 1024;
    const duration = meta.count * frameTicks;
    const duration90 = Math.round(duration * 90000 / meta.sampleRate);
    const shift = meta.shift;
    const movieDuration = duration90 + shift;
    const bin = new Bin();
    bin.box("trak", (trak) => {
      trak.bytes(tkhd(2, movieDuration, 0, 0, 0x0100));
      const edit = elst(shift, duration90);
      if (edit) trak.bytes(edit);
      trak.box("mdia", (mdia) => {
        mdia.bytes(mdhd(meta.sampleRate, duration));
        mdia.bytes(hdlr("soun", "SoundHandler"));
        mdia.box("minf", (minf) => {
          minf.box("smhd", (smhd) => {
            smhd.u32(0);
            smhd.u16(0);
            smhd.u16(0);
          });
          minf.bytes(dinf());
          minf.box("stbl", (stbl) => {
            stbl.bytes(stsdBox(mp4aBox(meta.sampleRate, meta.channels, meta.config, meta.avgBitrate)));
            stbl.bytes(sttsConstant(meta.count, frameTicks));
            stbl.bytes(stscBox());
            stbl.bytes(stszBox(meta.sizes));
            stbl.bytes(co64Box(meta.offsets));
          });
        });
      });
    });
    return { box: bin.toUint8(), movieDuration };
  }

  function moov(video, audio) {
    const movieDuration = Math.max(video ? video.movieDuration : 0, audio ? audio.movieDuration : 0);
    const bin = new Bin();
    bin.box("moov", (box) => {
      box.box("mvhd", (mvhd) => {
        mvhd.u32(1 << 24);
        mvhd.u64(0);
        mvhd.u64(0);
        mvhd.u32(90000);
        mvhd.u64(movieDuration);
        mvhd.u32(0x00010000);
        mvhd.u16(0x0100);
        mvhd.u16(0);
        mvhd.zeros(8);
        matrix(mvhd);
        mvhd.zeros(24);
        mvhd.u32(audio ? 3 : 2);
      });
      if (video) box.bytes(video.box);
      if (audio) box.bytes(audio.box);
    });
    return bin.toUint8();
  }

  class TsToMp4 {
    constructor(sink, options) {
      this.sink = sink;
      this.fallbackWidth = options && options.width ? options.width : 0;
      this.fallbackHeight = options && options.height ? options.height : 0;
      this.demux = new TsDemuxer();
      this.videoMeta = [];
      this.audioSizes = [];
      this.audioOffsets = [];
      this.audioBytes = 0;
      this.mdatHeaderPos = 0;
      this.payloadStart = 0;
    }

    async start() {
      await this.sink.write(ftyp());
      this.mdatHeaderPos = this.sink.position;
      await this.sink.write(mdatHeader(0));
      this.payloadStart = this.sink.position;
    }

    async pushSegment(bytes) {
      if (!this.sawTs) {
        this.sawTs = true;
        const sample = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
        if (sample[0] !== 0x47 && sample.indexOf(0x47) === -1) {
          throw new Error("Потік не у форматі MPEG-TS");
        }
      }
      const beforeVideo = this.demux.videoSamples.length;
      const beforeAudio = this.demux.audioFrames.length;
      this.demux.push(bytes);
      const videos = this.demux.videoSamples.splice(beforeVideo);
      const audios = this.demux.audioFrames.splice(beforeAudio);
      for (const sample of videos) {
        const offset = this.sink.position;
        await this.sink.write(sample.data);
        this.videoMeta.push({
          dts: sample.dts,
          pts: sample.pts,
          key: sample.key,
          size: sample.data.byteLength,
          offset,
        });
      }
      for (const frame of audios) {
        const offset = this.sink.position;
        await this.sink.write(frame);
        this.audioOffsets.push(offset);
        this.audioSizes.push(frame.byteLength);
        this.audioBytes += frame.byteLength;
      }
    }

    async finish() {
      if (!this.videoMeta.length) throw new Error("У потоці немає відеокадрів");
      if (!this.demux.sps || !this.demux.pps) throw new Error("Не вдалося прочитати параметри відео");
      if (this.demux.audioType === 0x11) throw new Error("Аудіо у форматі LATM не підтримується");

      await this.sink.flush();
      const payloadSize = this.sink.position - this.payloadStart;
      await this.sink.writeAt(this.mdatHeaderPos, mdatHeader(payloadSize + 16));

      let dimensions = { width: this.fallbackWidth || 1280, height: this.fallbackHeight || 720 };
      try {
        const parsed = parseSps(this.demux.sps);
        if (parsed.width > 0 && parsed.height > 0 && parsed.width < 10000 && parsed.height < 10000) {
          dimensions = parsed;
        }
      } catch (error) {
        if (!this.fallbackWidth) throw error;
      }

      const deltas = [];
      for (let i = 0; i < this.videoMeta.length - 1; i++) {
        const delta = this.videoMeta[i + 1].dts - this.videoMeta[i].dts;
        if (delta > 0 && delta < 900000) deltas.push(delta);
      }
      const frameDuration = mode(deltas.length ? deltas : [3000]);
      const firstVideoDts = this.videoMeta[0].dts;
      const firstAudioPts = this.demux.audioStartPts;
      const base = Math.min(firstVideoDts, firstAudioPts == null ? firstVideoDts : firstAudioPts);
      const video = videoTrack({
        samples: this.videoMeta,
        frameDuration,
        width: dimensions.width,
        height: dimensions.height,
        sps: this.demux.sps,
        pps: this.demux.pps,
        shift: firstVideoDts - base,
      });

      let audio = null;
      if (this.audioSizes.length && this.demux.audioConfig) {
        const config = this.demux.audioConfig;
        const durationSec = this.audioSizes.length * 1024 / config.sampleRate;
        const avgBitrate = durationSec > 0 ? Math.round(this.audioBytes * 8 / durationSec) : 128000;
        audio = audioTrack({
          count: this.audioSizes.length,
          sizes: this.audioSizes,
          offsets: this.audioOffsets,
          sampleRate: config.sampleRate,
          channels: config.channels,
          config: config.bytes,
          avgBitrate,
          shift: (firstAudioPts == null ? base : firstAudioPts) - base,
        });
      }

      await this.sink.write(moov(video, audio));
      await this.sink.flush();
      return {
        width: dimensions.width,
        height: dimensions.height,
        videoSamples: this.videoMeta.length,
        audioSamples: this.audioSizes.length,
      };
    }
  }

  VD.TsToMp4 = TsToMp4;
  VD.parseSps = parseSps;

  if (typeof module !== "undefined" && module.exports) {
    module.exports = VD;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
