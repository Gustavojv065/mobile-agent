import { describe, expect, it } from "vitest";

import {
  hasAudioAnalysisHost,
  requestAudioAnalysis,
  subscribeAudioAnalysis,
  type AudioAnalysisJob,
} from "@/modules/preview/video-audio-analysis-job";

describe("video-audio-analysis-job queue", () => {
  it("reports no host until a subscriber registers", () => {
    expect(hasAudioAnalysisHost()).toBe(false);
    const unsubscribe = subscribeAudioAnalysis(() => {});
    expect(hasAudioAnalysisHost()).toBe(true);
    unsubscribe();
    expect(hasAudioAnalysisHost()).toBe(false);
  });

  it("rejects when no host is mounted", async () => {
    await expect(
      requestAudioAnalysis({ src: "data:audio/mpeg;base64,QUJD" }),
    ).rejects.toThrow(/only available on builds/);
  });

  it("rejects an empty source", async () => {
    await expect(requestAudioAnalysis({ src: "" })).rejects.toThrow(
      /No audio source/,
    );
  });

  it("rejects an already-aborted request", async () => {
    const unsubscribe = subscribeAudioAnalysis(() => {});
    try {
      const controller = new AbortController();
      controller.abort();
      await expect(
        requestAudioAnalysis({
          src: "data:audio/mpeg;base64,QUJD",
          signal: controller.signal,
        }),
      ).rejects.toThrow(/cancelled/);
    } finally {
      unsubscribe();
    }
  });

  it("dispatches a job with defaults and resolves it", async () => {
    let received: AudioAnalysisJob | null = null;
    const unsubscribe = subscribeAudioAnalysis((job) => {
      received = job;
    });
    try {
      const promise = requestAudioAnalysis({
        src: "data:audio/mpeg;base64,QUJD",
      });
      expect(received).not.toBeNull();
      const job = received as unknown as AudioAnalysisJob;
      expect(job.maxSeconds).toBe(90);
      expect(job.sampleRate).toBe(22050);
      expect(job.curvePoints).toBe(24);

      job.resolve({
        summary: {
          ready: true,
          duration: 1,
          frameRate: 10,
          bpm: 120,
          beatCount: 2,
          beats: [0.1, 0.6],
          curvePoints: 2,
          curveStepSeconds: 0.5,
          energy: [0.2, 0.8],
          low: [0, 0],
          mid: [0, 0],
          high: [0, 0],
          onset: [0, 0],
        },
      });

      await expect(promise).resolves.toMatchObject({
        summary: { ready: true, bpm: 120, beats: [0.1, 0.6] },
      });
    } finally {
      unsubscribe();
    }
  });

  it("honors caller overrides", async () => {
    let received: AudioAnalysisJob | null = null;
    const unsubscribe = subscribeAudioAnalysis((job) => {
      received = job;
    });
    try {
      const promise = requestAudioAnalysis({
        src: "data:audio/x;base64,QQ==",
        maxSeconds: 30,
        sampleRate: 16000,
        maxBeats: 5,
        curvePoints: 8,
        pcmSampleRate: 16000,
      });
      promise.catch(() => {});
      const job = received as unknown as AudioAnalysisJob;
      expect(job.maxSeconds).toBe(30);
      expect(job.sampleRate).toBe(16000);
      expect(job.maxBeats).toBe(5);
      expect(job.curvePoints).toBe(8);
      expect(job.pcmSampleRate).toBe(16000);
      job.reject(new Error("done"));
    } finally {
      unsubscribe();
    }
  });

  it("passes the decoded PCM through the job result", async () => {
    let received: AudioAnalysisJob | null = null;
    const unsubscribe = subscribeAudioAnalysis((job) => {
      received = job;
    });
    try {
      const promise = requestAudioAnalysis({
        src: "data:audio/x;base64,QQ==",
        pcmSampleRate: 16000,
      });
      const job = received as unknown as AudioAnalysisJob;
      job.resolve({
        summary: {
          ready: true,
          duration: 1,
          frameRate: 10,
          bpm: null,
          beatCount: 0,
          beats: [],
          curvePoints: 2,
          curveStepSeconds: 0.5,
          energy: [0, 0],
          low: [0, 0],
          mid: [0, 0],
          high: [0, 0],
          onset: [0, 0],
        },
        pcm: { base64: "AAAA", sampleRate: 16000 },
      });

      await expect(promise).resolves.toMatchObject({
        pcm: { base64: "AAAA", sampleRate: 16000 },
      });
    } finally {
      unsubscribe();
    }
  });
});
