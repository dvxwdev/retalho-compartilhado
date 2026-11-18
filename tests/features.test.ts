import { describe, expect, it } from "vitest";
import { createProject, findSegment, outputSize, projectDuration, type Project } from "../src/core/model";
import {
  addAdjustmentMaterial,
  addTextMaterial,
  adjacentMarker,
  copySegment,
  cutSourceRanges,
  deleteSegment,
  duplicateSegment,
  extractAudio,
  extractRange,
  freezeFrame,
  groupMembers,
  moveSegment,
  pasteAttributes,
  pasteSegment,
  placeMaterial,
  removeMarker,
  rotateQuarter,
  setGroup,
  setProp,
  setSpeed,
  shiftSegments,
  setTransition,
  snapPoints,
  splitSegment,
  trimEnd,
  toggleKeyframe,
  toggleMarker,
  trimStart,
  updateMaterial,
  updateSegment,
  updateTrack,
} from "../src/core/ops";
import { audioPlan, resolveFrame } from "../src/core/resolve";
import { encodeWav } from "../src/core/wav";

const S = 1_000_000;

function withVideo(seconds = 10): Project {
  const project = createProject();
  project.materials.clip = {
    id: "clip",
    kind: "video",
    name: "clip.mp4",
    duration: seconds * S,
    width: 1920,
    height: 1080,
    hasAudio: true,
  };
  return project;
}

describe("locked track", () => {
  function locked() {
    const placed = placeMaterial(withVideo(), "clip", 0);
    const trackId = placed.project.tracks[0]!.id;
    return { project: updateTrack(placed.project, trackId, { locked: true }), id: placed.segmentId, trackId };
  }

  it("refuses every edit to its clips", () => {
    const { project, id, trackId } = locked();
    expect(moveSegment(project, id, 5 * S, trackId)).toBe(project);
    expect(trimEnd(project, id, 2 * S)).toBe(project);
    expect(deleteSegment(project, id)).toBe(project);
    expect(setSpeed(project, id, 2)).toBe(project);
    expect(setProp(project, id, "x", 0.5, 0)).toBe(project);
    expect(splitSegment(project, id, 2 * S)).toBeNull();
  });

  it("does not receive new or moved clips", () => {
    const { project, trackId } = locked();
    const placed = placeMaterial(project, "clip", 20 * S, trackId);
    expect(placed.project.tracks).toHaveLength(2);
    expect(placed.project.tracks[0]!.segments).toHaveLength(1);
    const moved = moveSegment(placed.project, placed.segmentId, 30 * S, trackId);
    expect(moved).toBe(placed.project);
  });
});

describe("clipboard", () => {
  it("pastes on the original track when free and keeps the look", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    const styled = updateSegment(placed.project, placed.segmentId, (segment) => {
      segment.adjust.brightness = 40;
    });
    const pasted = pasteSegment(styled, copySegment(styled, placed.segmentId)!, 20 * S)!;
    expect(pasted.project.tracks).toHaveLength(1);
    const [, copy] = pasted.project.tracks[0]!.segments;
    expect(copy!.id).toBe(pasted.segmentId);
    expect(copy!.id).not.toBe(placed.segmentId);
    expect(copy!.target.start).toBe(20 * S);
    expect(copy!.adjust.brightness).toBe(40);
  });

  it("opens another track when the time is taken", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    const pasted = pasteSegment(placed.project, copySegment(placed.project, placed.segmentId)!, 2 * S)!;
    expect(pasted.project.tracks).toHaveLength(2);
    expect(pasted.project.tracks[1]!.segments[0]!.target.start).toBe(2 * S);
  });

  it("gives a pasted text its own content", () => {
    const added = addTextMaterial(createProject(), "original");
    const placed = placeMaterial(added.project, added.materialId, 0);
    const pasted = pasteSegment(placed.project, copySegment(placed.project, placed.segmentId)!, 10 * S)!;
    const [first, second] = pasted.project.tracks[0]!.segments;
    expect(second!.materialId).not.toBe(first!.materialId);
    const edited = updateMaterial(pasted.project, second!.materialId, { text: "copia" } as never);
    expect((edited.materials[first!.materialId] as { text: string }).text).toBe("original");
  });

  it("does not bring a transition with the copy", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    const faded = updateSegment(placed.project, placed.segmentId, (segment) => {
      segment.transitionOut = { type: "fade", duration: S };
    });
    const pasted = pasteSegment(faded, copySegment(faded, placed.segmentId)!, 20 * S)!;
    expect(pasted.project.tracks[0]!.segments[1]!.transitionOut).toBeNull();
  });

  it("duplicates right after the clip, skipping what is in the way", () => {
    const first = placeMaterial(withVideo(2), "clip", 0);
    const second = placeMaterial(first.project, "clip", 2 * S, first.project.tracks[0]!.id);
    const copied = duplicateSegment(second.project, first.segmentId)!;
    const starts = copied.project.tracks[0]!.segments.map((segment) => segment.target.start);
    expect(starts).toEqual([0, 2 * S, 4 * S]);
  });
});

describe("paste attributes", () => {
  it("copies the look and keeps content and timing", () => {
    const first = placeMaterial(withVideo(), "clip", 0);
    const second = placeMaterial(first.project, "clip", 10 * S);
    let project = updateSegment(second.project, first.segmentId, (segment) => {
      segment.adjust.contrast = 25;
      segment.transform.scale = 2;
      segment.volume = 0.5;
    });
    project = pasteAttributes(project, second.segmentId, copySegment(project, first.segmentId)!.segment);
    const target = project.tracks[0]!.segments[1]!;
    expect(target.adjust.contrast).toBe(25);
    expect(target.transform.scale).toBe(2);
    expect(target.volume).toBe(0.5);
    expect(target.target).toEqual({ start: 10 * S, duration: 10 * S });
    expect(target.materialId).toBe("clip");
  });

  it("fits keyframes and fades to a shorter clip", () => {
    const long = placeMaterial(withVideo(), "clip", 0);
    let project = toggleKeyframe(long.project, long.segmentId, "x", 0);
    project = setProp(project, long.segmentId, "x", 0.2, 0);
    project = toggleKeyframe(project, long.segmentId, "x", 8 * S);
    project = setProp(project, long.segmentId, "x", 1, 8 * S);
    project = updateSegment(project, long.segmentId, (segment) => {
      segment.fadeOut = 9 * S;
    });
    const short = placeMaterial(project, "clip", 20 * S);
    const trimmed = trimEnd(short.project, short.segmentId, 24 * S);
    const pasted = pasteAttributes(trimmed, short.segmentId, copySegment(trimmed, long.segmentId)!.segment);
    const target = pasted.tracks[0]!.segments[1]!;
    expect(target.fadeOut).toBe(4 * S);
    expect(target.keyframes.x!.at(-1)!.offset).toBe(4 * S);
    expect(target.keyframes.x!.at(-1)!.value).toBeCloseTo(0.6);
  });
});

describe("markers", () => {
  it("adds in time order and removes on the same frame", () => {
    let project = toggleMarker(createProject(), 3 * S);
    project = toggleMarker(project, 1 * S);
    expect(project.markers!.map((marker) => marker.time)).toEqual([1 * S, 3 * S]);
    expect(project.markers!.map((marker) => marker.label)).toEqual(["Marcador 02", "Marcador 01"]);
    project = toggleMarker(project, 3 * S + 5_000);
    expect(project.markers!.map((marker) => marker.time)).toEqual([1 * S]);
  });

  it("never reuses a label after a removal", () => {
    let project = toggleMarker(toggleMarker(createProject(), 1 * S), 2 * S);
    project = removeMarker(project, project.markers![0]!.id);
    project = toggleMarker(project, 3 * S);
    expect(project.markers!.map((marker) => marker.label)).toEqual(["Marcador 02", "Marcador 03"]);
  });

  it("finds the neighbours of a time", () => {
    const project = toggleMarker(toggleMarker(createProject(), 1 * S), 3 * S);
    expect(adjacentMarker(project, 2 * S, 1)!.time).toBe(3 * S);
    expect(adjacentMarker(project, 2 * S, -1)!.time).toBe(1 * S);
    expect(adjacentMarker(project, 3 * S, 1)).toBeNull();
    expect(adjacentMarker(createProject(), 0, 1)).toBeNull();
  });

  it("works as a snap point", () => {
    expect(snapPoints(toggleMarker(createProject(), 7 * S), 0)).toContain(7 * S);
  });
});

describe("freeze frame", () => {
  function frozenAt(seconds: number) {
    const placed = placeMaterial(withVideo(), "clip", 0);
    return { ...freezeFrame(placed.project, placed.segmentId, seconds * S, 3 * S)!, clipId: placed.segmentId };
  }

  it("holds the frame and pushes the rest of the clip later", () => {
    const { project } = frozenAt(4);
    const [left, still, right] = project.tracks[0]!.segments;
    expect(left!.target).toEqual({ start: 0, duration: 4 * S });
    expect(still!.frozen).toBe(true);
    expect(still!.target).toEqual({ start: 4 * S, duration: 3 * S });
    expect(right!.target).toEqual({ start: 7 * S, duration: 6 * S });
    expect(right!.source.start).toBe(4 * S);
  });

  it("shows the same source frame for its whole length", () => {
    const { project } = frozenAt(4);
    const times = [4, 5, 6.9].map((seconds) => resolveFrame(project, seconds * S)[0]!.sourceTime);
    expect(times).toEqual([4 * S, 4 * S, 4 * S]);
    expect(resolveFrame(project, 7 * S)[0]!.sourceTime).toBe(4 * S);
  });

  it("is silent while the clips around it keep their sound", () => {
    const { project } = frozenAt(4);
    const plan = audioPlan(project, 0);
    expect(plan.map((event) => event.at)).toEqual([0, 7 * S]);
  });

  it("keeps its frame when trimmed or split", () => {
    const { project, segmentId } = frozenAt(4);
    const stretched = trimEnd(project, segmentId, 6 * S);
    expect(findSegment(stretched, segmentId)!.segment.target.duration).toBe(2 * S);
    expect(findSegment(stretched, segmentId)!.segment.source.start).toBe(4 * S);
    const shortened = trimStart(project, segmentId, 5 * S);
    expect(findSegment(shortened, segmentId)!.segment.source.start).toBe(4 * S);
    const split = splitSegment(project, segmentId, 5 * S)!;
    expect(resolveFrame(split.project, 6 * S)[0]!.sourceTime).toBe(4 * S);
    expect(resolveFrame(split.project, 4.5 * S)[0]!.sourceTime).toBe(4 * S);
  });

  it("can stretch past the length of the source", () => {
    const { project, segmentId } = frozenAt(4);
    const spaced = deleteSegment(project, project.tracks[0]!.segments[2]!.id);
    const stretched = trimEnd(spaced, segmentId, 60 * S);
    expect(findSegment(stretched, segmentId)!.segment.target.duration).toBe(56 * S);
  });

  it("ignores a speed change", () => {
    const { project, segmentId } = frozenAt(4);
    expect(setSpeed(project, segmentId, 2)).toBe(project);
  });

  it("keeps the position of animated clips at that moment", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    let project = toggleKeyframe(placed.project, placed.segmentId, "x", 0);
    project = toggleKeyframe(project, placed.segmentId, "x", 10 * S);
    project = setProp(project, placed.segmentId, "x", 1, 10 * S);
    const frozen = freezeFrame(project, placed.segmentId, 5 * S, 3 * S)!;
    const still = findSegment(frozen.project, frozen.segmentId)!.segment;
    expect(still.transform.x).toBeCloseTo(0.5);
    expect(still.keyframes).toEqual({});
  });

  it("goes before or after the clip at its very edges", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    const first = freezeFrame(placed.project, placed.segmentId, 0, S)!;
    expect(first.project.tracks[0]!.segments.map((item) => Boolean(item.frozen))).toEqual([true, false]);
    const last = freezeFrame(placed.project, placed.segmentId, 10 * S - 1, S)!;
    expect(last.project.tracks[0]!.segments.map((item) => Boolean(item.frozen))).toEqual([false, true]);
    const { sourceTime } = resolveFrame(last.project, 10 * S)[0]!;
    expect(sourceTime).toBeLessThan(10 * S);
  });

  it("only applies to video, inside the clip", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    expect(freezeFrame(placed.project, placed.segmentId, 20 * S)).toBeNull();
    const text = addTextMaterial(placed.project);
    const label = placeMaterial(text.project, text.materialId, 0);
    expect(freezeFrame(label.project, label.segmentId, S)).toBeNull();
    const { project, segmentId } = frozenAt(4);
    expect(freezeFrame(project, segmentId, 5 * S)).toBeNull();
  });
});

describe("framing", () => {
  it("turns in quarter steps and wraps around", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    let project = rotateQuarter(placed.project, placed.segmentId, 1, 0);
    expect(project.tracks[0]!.segments[0]!.transform.rotation).toBe(90);
    project = rotateQuarter(rotateQuarter(project, placed.segmentId, 1, 0), placed.segmentId, 1, 0);
    expect(project.tracks[0]!.segments[0]!.transform.rotation).toBe(-90);
    project = rotateQuarter(project, placed.segmentId, -1, 0);
    expect(project.tracks[0]!.segments[0]!.transform.rotation).toBe(180);
  });

  it("carries flip and blend through split and paste attributes", () => {
    const first = placeMaterial(withVideo(), "clip", 0);
    const second = placeMaterial(first.project, "clip", 10 * S);
    let project = updateSegment(second.project, first.segmentId, (segment) => {
      segment.flipX = true;
      segment.blend = "multiply";
    });
    const split = splitSegment(project, first.segmentId, 2 * S)!;
    expect(findSegment(split.project, split.rightId)!.segment.flipX).toBe(true);
    project = pasteAttributes(project, second.segmentId, copySegment(project, first.segmentId)!.segment);
    const target = findSegment(project, second.segmentId)!.segment;
    expect(target.flipX).toBe(true);
    expect(target.blend).toBe("multiply");
  });

  it("clears a flip when the copied clip has none", () => {
    const first = placeMaterial(withVideo(), "clip", 0);
    const second = placeMaterial(first.project, "clip", 10 * S);
    const flipped = updateSegment(second.project, second.segmentId, (segment) => {
      segment.flipY = true;
      segment.blend = "screen";
    });
    const project = pasteAttributes(flipped, second.segmentId, copySegment(flipped, first.segmentId)!.segment);
    const target = findSegment(project, second.segmentId)!.segment;
    expect(target.flipY).toBeFalsy();
    expect(target.blend).toBeUndefined();
  });
});

describe("extract audio", () => {
  it("moves the sound to an audio track, same time, and silences the clip", () => {
    const placed = placeMaterial(withVideo(), "clip", 2 * S);
    const extracted = extractAudio(placed.project, placed.segmentId)!;
    const video = extracted.project.tracks.find((track) => track.type === "video")!.segments[0]!;
    const audio = extracted.project.tracks.find((track) => track.type === "audio")!.segments[0]!;
    expect(video.volume).toBe(0);
    expect(audio.id).toBe(extracted.segmentId);
    expect(audio.target).toEqual(video.target);
    expect(audio.source).toEqual(video.source);
    expect(audio.volume).toBe(1);
  });

  it("plays exactly once and draws nothing extra", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    const { project } = extractAudio(placed.project, placed.segmentId)!;
    expect(audioPlan(project, 0)).toHaveLength(1);
    expect(resolveFrame(project, S)).toHaveLength(1);
  });

  it("keeps the volume and speed of the clip", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    let project = setSpeed(placed.project, placed.segmentId, 2);
    project = updateSegment(project, placed.segmentId, (segment) => {
      segment.volume = 0.4;
    });
    const [event] = audioPlan(extractAudio(project, placed.segmentId)!.project, 0);
    expect(event!.gain).toBe(0.4);
    expect(event!.rate).toBe(2);
  });

  it("refuses clips with nothing to extract", () => {
    const silent = withVideo();
    (silent.materials.clip as { hasAudio: boolean }).hasAudio = false;
    const placed = placeMaterial(silent, "clip", 0);
    expect(extractAudio(placed.project, placed.segmentId)).toBeNull();
    const again = placeMaterial(withVideo(), "clip", 0);
    const done = extractAudio(again.project, again.segmentId)!;
    expect(extractAudio(done.project, again.segmentId)).toBeNull();
    expect(extractAudio(done.project, done.segmentId)).toBeNull();
  });
});

describe("export size", () => {
  it("keeps the project size without a target", () => {
    expect(outputSize({ width: 1920, height: 1080 })).toEqual({ width: 1920, height: 1080 });
  });

  it("scales by the short side in any orientation", () => {
    expect(outputSize({ width: 1920, height: 1080 }, 720)).toEqual({ width: 1280, height: 720 });
    expect(outputSize({ width: 1080, height: 1920 }, 720)).toEqual({ width: 720, height: 1280 });
    expect(outputSize({ width: 1920, height: 1080 }, 2160)).toEqual({ width: 3840, height: 2160 });
  });

  it("always gives even sizes", () => {
    const { width, height } = outputSize({ width: 1080, height: 1350 }, 721);
    expect(width % 2).toBe(0);
    expect(height % 2).toBe(0);
  });
});

describe("wav", () => {
  const left = new Float32Array([0, 0.5, 1, 2]);
  const right = new Float32Array([0, -0.5, -1, -2]);
  const view = new DataView(encodeWav([left, right], 48000));
  const tag = (offset: number) =>
    String.fromCharCode(...[0, 1, 2, 3].map((index) => view.getUint8(offset + index)));

  it("writes a valid header", () => {
    expect(tag(0)).toBe("RIFF");
    expect(tag(8)).toBe("WAVE");
    expect(tag(36)).toBe("data");
    expect(view.getUint32(4, true)).toBe(view.byteLength - 8);
    expect(view.getUint16(22, true)).toBe(2);
    expect(view.getUint32(24, true)).toBe(48000);
    expect(view.getUint32(28, true)).toBe(48000 * 4);
    expect(view.getUint32(40, true)).toBe(16);
  });

  it("interleaves channels and clips past full scale", () => {
    const sample = (index: number) => view.getInt16(44 + index * 2, true);
    expect(sample(2)).toBe(16384);
    expect(sample(3)).toBe(-16383);
    expect(sample(6)).toBe(32767);
    expect(sample(7)).toBe(-32767);
  });
});

describe("reversed clip", () => {
  function reversed() {
    const placed = placeMaterial(withVideo(), "clip", 0);
    return {
      id: placed.segmentId,
      project: updateSegment(placed.project, placed.segmentId, (segment) => {
        segment.reversed = true;
      }),
    };
  }

  it("reads the source from the end to the start", () => {
    const { project } = reversed();
    const at = (seconds: number) => resolveFrame(project, seconds * S)[0]!.sourceTime / S;
    expect(at(0)).toBeCloseTo(10 - 1 / 30, 2);
    expect(at(5)).toBeCloseTo(5 - 1 / 30, 2);
    expect(at(9.9)).toBeLessThan(0.2);
  });

  it("keeps playing the same moments after a split", () => {
    const { project, id } = reversed();
    const split = splitSegment(project, id, 3 * S)!;
    const at = (seconds: number) => resolveFrame(split.project, seconds * S)[0]!.sourceTime;
    expect(at(1)).toBe(resolveFrame(project, 1 * S)[0]!.sourceTime);
    expect(at(6)).toBe(resolveFrame(project, 6 * S)[0]!.sourceTime);
  });

  it("trims the moments at each end of what plays", () => {
    const { project, id } = reversed();
    const start = trimStart(project, id, 2 * S);
    expect(findSegment(start, id)!.segment.source).toEqual({ start: 0, duration: 8 * S });
    const end = trimEnd(project, id, 8 * S);
    expect(findSegment(end, id)!.segment.source).toEqual({ start: 2 * S, duration: 8 * S });
  });

  it("can grow back after a trim", () => {
    const { project, id } = reversed();
    const trimmed = trimEnd(project, id, 8 * S);
    const back = trimEnd(trimmed, id, 12 * S);
    expect(findSegment(back, id)!.segment.source).toEqual({ start: 0, duration: 10 * S });
  });

  it("tells the audio plan to play backwards", () => {
    const { project } = reversed();
    expect(audioPlan(project, 0)[0]!.reversed).toBe(true);
  });

  it("refuses cuts by source time, which would land in the wrong place", () => {
    const { project, id } = reversed();
    expect(cutSourceRanges(project, id, [{ start: 2 * S, end: 3 * S }])).toBe(project);
  });
});

describe("exporting a stretch", () => {
  it("keeps only that time, starting at zero", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    const part = extractRange(placed.project, 2 * S, 5 * S);
    expect(projectDuration(part)).toBe(3 * S);
    expect(resolveFrame(part, 0)[0]!.sourceTime).toBe(2 * S);
  });

  it("includes every track, even locked ones", () => {
    const first = placeMaterial(withVideo(), "clip", 0);
    const second = placeMaterial(first.project, "clip", 2 * S);
    const locked = updateTrack(second.project, second.project.tracks[1]!.id, { locked: true });
    const part = extractRange(locked, 3 * S, 5 * S);
    expect(part.tracks).toHaveLength(2);
    expect(part.tracks[1]!.segments[0]!.source.start).toBe(1 * S);
  });

  it("leaves the project itself untouched", () => {
    const { project } = placeMaterial(withVideo(), "clip", 0);
    extractRange(project, 2 * S, 5 * S);
    expect(projectDuration(project)).toBe(10 * S);
  });
});

describe("more transitions", () => {
  function joined(type: "push" | "zoom" | "spin" | "iris") {
    const first = placeMaterial(withVideo(4), "clip", 0);
    const second = placeMaterial(first.project, "clip", 4 * S, first.project.tracks[0]!.id);
    return setTransition(second.project, first.segmentId, { type, duration: 2 * S });
  }

  it("pushes one clip out as the other comes in", () => {
    const [out, into] = resolveFrame(joined("push"), 4 * S);
    expect(out!.transform.y).toBeCloseTo(1);
    expect(into!.transform.y).toBeCloseTo(-1);
  });

  it("zooms through the cut", () => {
    const [out, into] = resolveFrame(joined("zoom"), 4 * S);
    expect(out!.transform.scale).toBeGreaterThan(1);
    expect(into!.transform.scale).toBeLessThan(1);
    expect(out!.opacityMul + into!.opacityMul).toBeCloseTo(1);
  });

  it("spins the new clip into place", () => {
    const [, into] = resolveFrame(joined("spin"), 4 * S);
    expect(into!.transform.rotation).toBeCloseTo(-90);
    expect(into!.transform.scale).toBeCloseTo(0.5);
  });

  it("opens a circle over the outgoing clip", () => {
    const [, into] = resolveFrame(joined("iris"), 4 * S);
    expect(into!.revealCircle).toBeCloseTo(0.5);
  });

  it("does not change the clips themselves", () => {
    const project = joined("zoom");
    resolveFrame(project, 4 * S);
    expect(project.tracks[0]!.segments[0]!.transform.scale).toBe(1);
  });
});

describe("adjustment layer", () => {
  it("sits on a track above the videos and draws in order", () => {
    const placed = placeMaterial(withVideo(), "clip", 0);
    const added = addAdjustmentMaterial(placed.project);
    const adjustment = placeMaterial(added.project, added.materialId, 0);
    const layers = resolveFrame(adjustment.project, S);
    expect(layers.map((layer) => layer.material.kind)).toEqual(["video", "adjustment"]);
  });
});

describe("moving several clips", () => {
  function pair() {
    const first = placeMaterial(withVideo(2), "clip", 0);
    const second = placeMaterial(first.project, "clip", 5 * S, first.project.tracks[0]!.id);
    return { project: second.project, a: first.segmentId, b: second.segmentId };
  }

  it("keeps the distance between them", () => {
    const { project, a, b } = pair();
    const moved = shiftSegments(project, [a, b], 3 * S);
    expect(moved.tracks[0]!.segments.map((segment) => segment.target.start)).toEqual([3 * S, 8 * S]);
  });

  it("stops at the start of the timeline without squashing them", () => {
    const { project, a, b } = pair();
    const shifted = shiftSegments(project, [a, b], 2 * S);
    const back = shiftSegments(shifted, [a, b], -10 * S);
    expect(back.tracks[0]!.segments.map((segment) => segment.target.start)).toEqual([0, 5 * S]);
  });

  it("refuses to land on a clip that stays", () => {
    const { project, a } = pair();
    expect(shiftSegments(project, [a], 4 * S)).toBe(project);
  });

  it("refuses when a clip is on a locked track", () => {
    const { project, a, b } = pair();
    const locked = updateTrack(project, project.tracks[0]!.id, { locked: true });
    expect(shiftSegments(locked, [a, b], S)).toBe(locked);
  });

  it("finds the whole group from any member", () => {
    const { project, a, b } = pair();
    const grouped = setGroup(project, [a, b], "g");
    expect(groupMembers(grouped, a).sort()).toEqual([a, b].sort());
    const free = setGroup(grouped, [a, b], null);
    expect(groupMembers(free, a)).toEqual([a]);
  });
});
