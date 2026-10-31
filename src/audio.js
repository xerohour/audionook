// ===========================================================================
// audio.js — WAV/MP3 helpers: encode WAV, encode MP3 (lamejs in a worker),
// and join many blobs into a single downloadable file.
// Lifted verbatim from the original single-file generator (the exact
// encode/join steps matter for producing non-corrupt MP3s on Chrome).
// ===========================================================================


export async function joinWavFiles(wavArrayBuffers) {
    if(!window.concatAudioBuffers) {
      let { concat } = await import("https://esm.sh/audio-buffer-utils@5.1.2?bundle&pin=v135");
      window.concatAudioBuffers = concat;
    }
    const audioContext = new (window.AudioContext || window.webkitAudioContext)();
    let audioBuffers = [];
    console.debug("joining wav files internal....")
    for(let buffer of wavArrayBuffers) {
      audioBuffers.push(await audioContext.decodeAudioData(buffer.slice(0)));
    }
    let result = concatAudioBuffers(audioBuffers);
    audioContext.close(); // help GC out
    return result;
  }

  // Convert an AudioBuffer to a WAV ArrayBuffer
export function audioBufferToWav(buffer, opts) {
    opts = opts || {};
    const numChannels = buffer.numberOfChannels;
    const sampleRate = buffer.sampleRate;
    const format = opts.float32 ? 3 : 1;
    const bitDepth = format === 3 ? 32 : 16;
    let samples;
    if (numChannels === 2) {
      samples = interleave(buffer.getChannelData(0), buffer.getChannelData(1));
    } else {
      samples = buffer.getChannelData(0);
    }
    let result = encodeWAV(samples, numChannels, sampleRate, bitDepth);
    return result;
  }

  // Interleave two channels (for stereo)
  function interleave(inputL, inputR) {
    const length = inputL.length + inputR.length;
    const result = new Float32Array(length);
    let index = 0;
    let inputIndex = 0;
    while (inputIndex < inputL.length) {
      result[index++] = inputL[inputIndex];
      result[index++] = inputR[inputIndex];
      inputIndex++;
    }
    return result;
  }

  // Build WAV file header and data
  function encodeWAV(samples, numChannels, sampleRate, bitDepth) {
    const bytesPerSample = bitDepth / 8;
    const blockAlign = numChannels * bytesPerSample;
    const buffer = new ArrayBuffer(44 + samples.length * bytesPerSample);
    const view = new DataView(buffer);

    /* RIFF identifier */
    writeString(view, 0, "RIFF");
    /* RIFF chunk length */
    view.setUint32(4, 36 + samples.length * bytesPerSample, true);
    /* RIFF type */
    writeString(view, 8, "WAVE");
    /* format chunk identifier */
    writeString(view, 12, "fmt ");
    /* format chunk length */
    view.setUint32(16, 16, true);
    /* sample format (1 = PCM) */
    view.setUint16(20, 1, true);
    /* channel count */
    view.setUint16(22, numChannels, true);
    /* sample rate */
    view.setUint32(24, sampleRate, true);
    /* byte rate (sample rate * block align) */
    view.setUint32(28, sampleRate * blockAlign, true);
    /* block align (channel count * bytes per sample) */
    view.setUint16(32, blockAlign, true);
    /* bits per sample */
    view.setUint16(34, bitDepth, true);
    /* data chunk identifier */
    writeString(view, 36, "data");
    /* data chunk length */
    view.setUint32(40, samples.length * bytesPerSample, true);

    if (bitDepth === 16) {
      floatTo16BitPCM(view, 44, samples);
    } else {
      writeFloat32(view, 44, samples);
    }
    return buffer;
  }

  function writeString(view, offset, string) {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  }

  function floatTo16BitPCM(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 2) {
      let s = Math.max(-1, Math.min(1, input[i]));
      output.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }
  }

  function writeFloat32(output, offset, input) {
    for (let i = 0; i < input.length; i++, offset += 4) {
      output.setFloat32(offset, input[i], true);
    }
  }
// MP3 encoding runs in a pool of classic workers (lamejs is UMD, loaded via
// importScripts — module workers can't use it). The pool is shared process-wide:
// TTS workers finish chunks concurrently, and a single encoder would serialize
// them all behind one encode each (~45 ms fixed + ~11 ms per audio-second).
// Pool size follows the background-thread budget (see cpuBudget): the TTS and
// MP3 pools draw from the same half-of-cores allowance, roughly a third of it
// going to encoders. 64-core desktop => 6 (unchanged); 4-core phone => 1.
// (see scratch/mp3-pool-tuning.md for the original sizing work). Accepts a
// WAV Blob (legacy) or
// a WAV ArrayBuffer, which is
// transferred (zero-copy) — the TTS hot path passes the worker's buffer
// straight through with no main-thread decode/re-encode.

// HARD RULE: all background workers combined (every TTS pool + this MP3 pool)
// never use more than half of navigator.hardwareConcurrency. This tab shares
// the device with the app/game around it — synthesis stays above realtime
// long before the ceiling binds, so the spare cores are pure responsiveness.
export function cpuBudget(cores) {
  return Math.max(1, Math.floor((cores || 4) / 2));
}

// This pool's share of the background budget: 1 encoder on tiny devices
// (a 4-core phone runs 1 TTS + 1 MP3 worker = exactly its budget of 2),
// up to 6 on big desktops.
export function computeMp3PoolSize(cores) {
  const budget = cpuBudget(cores);
  if (budget <= 2) return 1;
  return Math.max(1, Math.min(6, Math.floor(budget / 3)));
}
export async function wav16ToMp3Blob(wavBlobOrBuffer) {
    // If the pool does not yet exist, create and initialize it
    if (!wav16ToMp3Blob._pool) {
      // 1) Create the inline worker code
      const workerCode = `
        // Import LAME library
        importScripts('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');
  
        /**
         * Parse a 16-bit WAV from an ArrayBuffer
         */
        function parseWavFile(wavBuffer) {
          const dataView = new DataView(wavBuffer);
  
          if (
            dataView.getUint32(0, true) !== 0x46464952 ||  // "RIFF"
            dataView.getUint32(8, true) !== 0x45564157    // "WAVE"
          ) {
            throw new Error("Not a valid WAV file");
          }
  
          let offset = 12;
          let sampleRate, numChannels, bitsPerSample, audioFormat, pcmData;
  
          while (offset < dataView.byteLength) {
            const chunkId = dataView.getUint32(offset, true);
            const chunkSize = dataView.getUint32(offset + 4, true);
            offset += 8;
            switch (chunkId) {
              case 0x20746D66: // "fmt "
                audioFormat = dataView.getUint16(offset, true);
                numChannels = dataView.getUint16(offset + 2, true);
                sampleRate = dataView.getUint32(offset + 4, true);
                bitsPerSample = dataView.getUint16(offset + 14, true);
                break;
              case 0x61746164: // "data"
                if (audioFormat === 3 && bitsPerSample === 32) {
                  // 32-bit float (what the TTS workers emit): convert to 16-bit.
                  const f = new Float32Array(wavBuffer, offset, chunkSize / 4);
                  pcmData = new Int16Array(f.length);
                  for (let i = 0; i < f.length; i++) {
                    const s = Math.max(-1, Math.min(1, f[i]));
                    pcmData[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
                  }
                } else {
                  pcmData = new Int16Array(
                    wavBuffer,
                    offset,
                    chunkSize / 2
                  );
                }
                break;
              default:
                break;
            }
            offset += chunkSize;
          }
  
          if (numChannels === 2) {
            const left = new Int16Array(pcmData.length / 2);
            const right = new Int16Array(pcmData.length / 2);
            for (let i = 0, j = 0; i < pcmData.length; i += 2, j++) {
              left[j] = pcmData[i];
              right[j] = pcmData[i + 1];
            }
            return {
              channelData: [left, right],
              sampleRate,
              numChannels
            };
          } else {
            return {
              channelData: [pcmData],
              sampleRate,
              numChannels
            };
          }
        }
  
        // Handle messages from main thread
        self.onmessage = async function(e) {
          const { requestId, wavArrayBuffer } = e.data;
          const tEnc0 = performance.now();
  
          try {
            // Parse WAV
            const { channelData, sampleRate, numChannels } = parseWavFile(wavArrayBuffer);
            // Create LAME encoder
            const bitrate = 128;
            const mp3Encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
  
            let mp3Data = [];
            const blockSize = 1152;
  
            function encodeChunk(leftChunk, rightChunk) {
              let mp3buf;
              if (numChannels === 2) {
                mp3buf = mp3Encoder.encodeBuffer(leftChunk, rightChunk);
              } else {
                mp3buf = mp3Encoder.encodeBuffer(leftChunk);
              }
              if (mp3buf.length > 0) {
                mp3Data.push(mp3buf);
              }
            }
  
            const left = channelData[0];
            const right = numChannels === 2 ? channelData[1] : null;
  
            for (let i = 0; i < left.length; i += blockSize) {
              const leftSlice = left.subarray(i, i + blockSize);
              let rightSlice;
              if (right) {
                rightSlice = right.subarray(i, i + blockSize);
              }
              encodeChunk(leftSlice, rightSlice);
            }
  
            // Flush MP3
            const endData = mp3Encoder.flush();
            if (endData.length > 0) {
              mp3Data.push(endData);
            }
  
            // Send back the result
            self.postMessage({
              requestId,
              mp3Data,
              encMs: performance.now() - tEnc0,
              success: true
            });
          } catch (error) {
            self.postMessage({
              requestId,
              error: error.message,
              success: false
            });
          }
        };
      `;
  
      // 2) Create a blob from the inline worker code and initialize the pool
      const workerBlob = new Blob([workerCode], { type: 'application/javascript' });
      const workerUrl = URL.createObjectURL(workerBlob);
      wav16ToMp3Blob._pool = [];
      const mp3Size = computeMp3PoolSize(navigator.hardwareConcurrency || 4);
      for (let i = 0; i < mp3Size; i++) {
        const entry = { worker: new Worker(workerUrl), busy: false };
        // 6) When a pool worker finishes a job, resolve or reject the
        //    associated Promise, mark it free, and drain the queue.
        entry.worker.onmessage = (e) => {
          const { requestId, mp3Data, encMs, success, error } = e.data;
          const handlers = wav16ToMp3Blob._requestMap.get(requestId);
          entry.busy = false;
          if (!handlers) {
            // Shouldn't happen if we track everything correctly.
            console.warn('Received response for unknown requestId:', requestId);
          } else {
            const { resolve, reject } = handlers;
            wav16ToMp3Blob._requestMap.delete(requestId);
            if (success) {
              const mp3Blob = new Blob(mp3Data, { type: 'audio/mp3' });
              mp3Blob._encMs = encMs || 0;
              resolve(mp3Blob);
            } else {
              reject(new Error(error));
            }
          }
          // This worker is now free, try to drain the queue
          processQueue();
        };
        wav16ToMp3Blob._pool.push(entry);
      }
      // We can revoke the blob URL immediately after creating the workers
      URL.revokeObjectURL(workerUrl);

      // 3) Initialize a queue (array) for pending requests
      wav16ToMp3Blob._pendingRequests = [];

      // 4) Initialize a map to track promise resolvers/rejecters by requestId
      wav16ToMp3Blob._requestMap = new Map();

      // 7) Helper function to hand queued requests to free pool workers
      function processQueue() {
        while (wav16ToMp3Blob._pendingRequests.length > 0) {
          const idle = wav16ToMp3Blob._pool.find((p) => !p.busy);
          if (!idle) return;
          idle.busy = true;
          // Get the next request
          const { requestId, wavArrayBuffer } = wav16ToMp3Blob._pendingRequests.shift();
          // Post the request to the worker
          idle.worker.postMessage(
            {
              requestId,
              wavArrayBuffer,
            },
            [wavArrayBuffer] // Transfer ownership
          );
        }
      }

      // 8) Store the processQueue function on the main function for re-use below
      wav16ToMp3Blob._processQueue = processQueue;
    }

    // --- Actual usage path per call to wav16ToMp3Blob ---
    return new Promise(async (resolve, reject) => {
      // Create a unique requestId
      const requestId = Date.now() + Math.random();

      // ArrayBuffers transfer zero-copy; Blobs (legacy callers) are read first.
      const wavArrayBuffer = (wavBlobOrBuffer instanceof ArrayBuffer)
        ? wavBlobOrBuffer
        : await wavBlobOrBuffer.arrayBuffer();

      // Store the promise handlers in a Map so we can resolve/reject them later
      wav16ToMp3Blob._requestMap.set(requestId, { resolve, reject });

      // Push request onto the queue
      wav16ToMp3Blob._pendingRequests.push({
        requestId,
        wavArrayBuffer
      });

      // Kick off processing on any free pool worker
      wav16ToMp3Blob._processQueue();
    });
  }
  /**
   * Fast lossless join: every chunk was encoded by the same lamejs settings
   * (CBR 128 kbps, same sample rate), so the MP3 frames concatenate directly —
   * no decode/re-encode. Zero-copy in the common case: our own chunks are raw
   * frames with no headers, so the original blobs pass straight through as
   * `new Blob()` parts (a 10-hour book merges in milliseconds with ~0 extra
   * memory). Byte surgery happens only when a chunk actually carries an
   * ID3v2 tag or leading junk. Throws if any chunk fails validation — the
   * caller falls back to the slow re-encode path below.
   */
export async function concatMp3Blobs(mp3Blobs, onProgress) {
    const parts = [];
    for (let i = 0; i < mp3Blobs.length; i++) {
      const blob = mp3Blobs[i];
      // 11-byte probe: enough to spot ID3v2 ("ID3" + syncsafe length) and to
      // check the MPEG frame sync (11 set bits) at offset 0.
      const head = new Uint8Array(await blob.slice(0, 11).arrayBuffer());
      let part = null;
      if (head.length >= 2 && head[0] === 0xff && (head[1] & 0xe0) === 0xe0) {
        part = blob; // raw frames: zero-copy passthrough
      } else {
        // Header or junk present — read the chunk and find the first frame.
        const buf = new Uint8Array(await blob.arrayBuffer());
        let off = 0;
        if (buf.length > 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) {
          off = 10 + ((buf[6] & 0x7f) << 21) | ((buf[7] & 0x7f) << 14) |
            ((buf[8] & 0x7f) << 7) | (buf[9] & 0x7f);
        }
        let start = -1;
        const scanEnd = Math.min(buf.length - 1, off + 8192);
        for (let j = off; j < scanEnd; j++) {
          if (buf[j] === 0xff && (buf[j + 1] & 0xe0) === 0xe0) { start = j; break; }
        }
        if (start < 0) throw new Error("no MP3 frame sync in chunk " + i);
        // A view, not a copy: still one copy fewer than slice().buffer.
        part = buf.subarray(start);
      }
      parts.push(part);
      if (typeof onProgress === "function") onProgress((i + 1) / mp3Blobs.length);
    }
    return new Blob(parts, { type: "audio/mpeg" });
  }
  /**
   * @param {Blob[]} mp3Blobs - An array of MP3 Blob objects to concatenate.
   * @param {function} [onProgress] - Optional callback that will be invoked with a
   *   progress value (0 to 1) as significant steps are completed.
   */
export async function joinMp3Blobs(mp3Blobs, onProgress) {
    // Fast path first: lossless frame concatenation (~100x the slow path).
    // Falls back to decode+re-encode if any chunk fails validation.
    try {
      return await concatMp3Blobs(mp3Blobs, onProgress);
    } catch (e) {
      console.warn("fast MP3 concat failed, falling back to re-encode:", e);
    }
    return joinMp3BlobsSlow(mp3Blobs, onProgress);
  }
  /**
   * Slow join: decode every MP3 and re-encode the concatenation. Kept as the
   * fallback for chunks that fail fast-path validation (foreign encodings or
   * mismatched sample rates — the encoder throws on those instead of
   * producing a corrupt file).
   * @param {Blob[]} mp3Blobs - An array of MP3 Blob objects to concatenate.
   * @param {function} [onProgress] - Optional callback that will be invoked with a
   *   progress value (0 to 1) as significant steps are completed.
   */
export async function joinMp3BlobsSlow(mp3Blobs, onProgress) {
    // We'll decode each MP3 blob on the main thread, gather the channel data,
    // and then send it to a Worker that concatenates and encodes everything.
  
    // 1) Decode on main thread
    const audioCtx = new AudioContext();
    let decodedDataArray = []; // Array of { sampleRate, numChannels, channelData }
    
    // If provided, call onProgress(0) at the start
    if (typeof onProgress === "function") {
      onProgress(0);
    }
  
    for (let i = 0; i < mp3Blobs.length; i++) {
      const blob = mp3Blobs[i];
      const arrayBuffer = await blob.arrayBuffer();
      const audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  
      // Collect channel data as Float32Array
      const channelData = [];
      for (let c = 0; c < audioBuffer.numberOfChannels; c++) {
        channelData.push(audioBuffer.getChannelData(c));
      }
  
      decodedDataArray.push({
        sampleRate: audioBuffer.sampleRate,
        numChannels: audioBuffer.numberOfChannels,
        channelData // array of Float32Arrays
      });
  
      // Report decoding progress (0 -> 0.5)
      if (typeof onProgress === "function") {
        const decodeProgress = ((i + 1) / mp3Blobs.length) * 0.5;
        onProgress(decodeProgress);
      }
    }

    audioCtx.close();
  
    // Calculate total samples (for encoding progress)
    const totalSamples = decodedDataArray.reduce((acc, track) => {
      return acc + track.channelData[0].length;
    }, 0);
  
    // 2) Inline Worker code: merges all channel data and encodes to MP3
    const workerCode = `
      // Import the LAME library
      importScripts('https://cdn.jsdelivr.net/npm/lamejs@1.2.1/lame.min.js');
  
      /**
       * Convert Float32 samples to 16-bit PCM
       * LAME expects 16-bit integer samples
       */
      function floatTo16BitPCM(floatArray) {
        const output = new Int16Array(floatArray.length);
        for (let i = 0; i < floatArray.length; i++) {
          let s = Math.max(-1, Math.min(1, floatArray[i]));
          // Convert from [-1,1] to 16-bit range
          output[i] = s < 0 ? s * 0x8000 : s * 0x7FFF;
        }
        return output;
      }
  
      onmessage = function(e) {
        const { requestId, decodedDataArray, totalSamples } = e.data;
  
        try {
          if (!decodedDataArray.length) {
            throw new Error("No audio data provided.");
          }
  
          // We'll assume all have same #channels & sampleRate as the first track
          const sampleRate = decodedDataArray[0].sampleRate;
          const numChannels = decodedDataArray[0].numChannels;
          const bitrate = 128;
  
          // Create a new LAME encoder
          const mp3Encoder = new lamejs.Mp3Encoder(numChannels, sampleRate, bitrate);
          let mp3Data = [];
  
          // Helper to encode a pair (or single) of 16-bit buffers
          function encodeChunk(leftChunk, rightChunk) {
            let mp3buf;
            if (numChannels === 2) {
              mp3buf = mp3Encoder.encodeBuffer(leftChunk, rightChunk);
            } else {
              mp3buf = mp3Encoder.encodeBuffer(leftChunk);
            }
            if (mp3buf.length > 0) {
              mp3Data.push(mp3buf);
            }
          }
  
          // Encode in chunks
          const blockSize = 1152; // LAME optimal framesize
          let encodedSamples = 0;
  
          for (let track of decodedDataArray) {
            if (track.numChannels !== numChannels) {
              throw new Error("Channel mismatch among MP3 blobs - all must have the same number of channels.");
            }
            if (track.sampleRate !== sampleRate) {
              throw new Error("Sample rate mismatch - all blobs must have the same sample rate.");
            }
  
            // Convert float to 16-bit
            const left = floatTo16BitPCM(track.channelData[0]);
            const right = (numChannels === 2)
              ? floatTo16BitPCM(track.channelData[1])
              : null;
  
            // Encode in chunks
            for (let i = 0; i < left.length; i += blockSize) {
              const leftChunk = left.subarray(i, i + blockSize);
              let rightChunk = null;
              if (right) {
                rightChunk = right.subarray(i, i + blockSize);
              }
  
              encodeChunk(leftChunk, rightChunk);
  
              // Update progress
              encodedSamples += leftChunk.length;
              const progress = totalSamples ? (encodedSamples / totalSamples) : 1;
              postMessage({
                requestId,
                progress
              });
            }
          }
  
          // Flush encoder
          const endData = mp3Encoder.flush();
          if (endData.length > 0) {
            mp3Data.push(endData);
          }
  
          // Post final result
          // postMessage({
          //   requestId,
          //   mp3Data,
          //   success: true
          // }, mp3Data.map(o => o.buffer));

          (async function() {
            // to prevent crash in chrome, do it iteratively/slowly:
            async function createBlobChunked(bufs, opt={chunkSize:50, type:'audio/mpeg'}) {
              const chunks = [];
              for (let i=0; i<bufs.length; i+=opt.chunkSize) {
                chunks.push(new Blob(bufs.slice(i,i+opt.chunkSize), {type:opt.type}));
                await new Promise(r => setTimeout(r, 10));
              }
              return new Blob(chunks, {type:opt.type});
            }
            const mp3Blob = await createBlobChunked(mp3Data, {chunkSize:50, type:'audio/mpeg'});
            const mp3ArrayBuffer = await mp3Blob.arrayBuffer();
            postMessage({
              requestId,
              mp3ArrayBuffer,
              success: true
            }, [mp3ArrayBuffer]);
          })();
          
        } catch (error) {
          postMessage({
            requestId,
            error: error.message,
            success: false
          });
        }
      };
    `;
  
    // 3) Create Worker from inline code
    const workerBlob = new Blob([workerCode], { type: "application/javascript" });
    const workerUrl = URL.createObjectURL(workerBlob);
    const worker = new Worker(workerUrl);
    // Revoke the URL once the Worker is created
    URL.revokeObjectURL(workerUrl);
  
    // 4) Send our decoded data to the Worker and wait for the MP3
    return new Promise((resolve, reject) => {
      const requestId = Date.now() + Math.random();
  
      worker.onmessage = async (e) => {
        const { requestId: respId, mp3ArrayBuffer, success, error, progress } = e.data;
        
        if (respId === requestId) {
          // Handle incremental progress messages
          if (typeof progress === "number") {
            // The encoding phase will fill the second half of progress (0.5 -> 1)
            if (typeof onProgress === "function") {
              onProgress(0.5 + progress * 0.5);
            }
            return; // Don't resolve/reject yet
          }
  
          // Otherwise, it's either success or error
          if (success) {
            // Combine typed arrays into a single Blob
            const mp3Blob = new Blob([mp3ArrayBuffer], { type: "audio/mpeg" });
            
            resolve(mp3Blob);
          } else {
            reject(new Error(error));
          }
          worker.terminate();
        }
      };

      const transfer = decodedDataArray.map(o => o.channelData).flat().map(a => a.buffer);
      worker.postMessage({
        requestId,
        decodedDataArray,
        totalSamples
      }, transfer);

      // To allow GC:
      setTimeout(() => {
        mp3Blobs = null;
        decodedDataArray = null;
      }, 5*1000);
      
    });
  }