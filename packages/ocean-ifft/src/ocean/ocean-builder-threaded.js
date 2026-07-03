import {ocean_chunk} from './ocean-chunk.js';


export const ocean_builder_threaded = (() => {
	
	// Size the pool to the machine: all cores minus one for the main thread
	// (which drains worker results and uploads chunk geometry). Was a fixed 7,
	// tuned for an 8-core tablet - that undersubscribed 10-16-core desktops.
	const _NUM_WORKERS = Math.max(1, (globalThis.navigator?.hardwareConcurrency ?? 8) - 1);
	
	let _IDs = 0;
	
	class WorkerThread {
		constructor(s) {
			this.worker_ = new Worker(s, { type: 'module' });
			this.worker_.onmessage = (e) => {
				this._OnMessage(e);
			};
			this._resolve = null;
			this._id = _IDs++;
		}
		
		_OnMessage(e) {
			const resolve = this._resolve;
			this._resolve = null;
			resolve(e.data);
		}
		
		get id() {
			return this._id;
		}
		
		postMessage(s, resolve) {
			this._resolve = resolve;
			this.worker_.postMessage(s);
		}
	}
	
	
	class WorkerThreadPool {
		constructor(sz, entry) {
			this.workers_ = [...Array(sz)].map(_ => new WorkerThread(entry));
			this.free_ = [...this.workers_];
			this.busy_ = {};
			this.queue_ = [];
		}
		
		get length() {
			return this.workers_.length;
		}
		
		get Busy() {
			return this.queue_.length > 0 || Object.keys(this.busy_).length > 0;
		}
		
		Enqueue(workItem, resolve) {
			this.queue_.push([workItem, resolve]);
			this._PumpQueue();
		}
		
		_PumpQueue() {
			while (this.free_.length > 0 && this.queue_.length > 0) {
				const w = this.free_.pop();
				this.busy_[w.id] = w;
				
				const [workItem, workResolve] = this.queue_.shift();
				
				w.postMessage(workItem, (v) => {
					delete this.busy_[w.id];
					this.free_.push(w);
					workResolve(v);
					this._PumpQueue();
				});
			}
		}
	}
	
	
	class _OceanChunkRebuilder_Threaded {
		constructor(params) {
			this.pool_ = {};
			this.old_ = [];
			
			// Diagnostic: Firefox clamps hardwareConcurrency to 2 under
			// privacy.resistFingerprinting, which would quietly gut this pool.
			console.log(`[ocean-builder] worker pool: ${_NUM_WORKERS} (hardwareConcurrency=${globalThis.navigator?.hardwareConcurrency})`);
			this.workerPool_ = new WorkerThreadPool(
				_NUM_WORKERS,
				new URL('./ocean-builder-threaded-worker.js', import.meta.url)
			);
			
			this.params_ = params;
		}
		
		_OnResult(chunk, msg) {
			chunk.RebuildMeshFromData(msg.data);
		}
		
		AllocateChunk(params) {
			const w = params.width;
			
			if (!(w in this.pool_)) {
				this.pool_[w] = [];
			}
			
			let c = null;
			if (this.pool_[w].length > 0) {
				c = this.pool_[w].pop();
				c.params_ = params;
			} else {
				c = new ocean_chunk.OceanChunk(params);
			}
			
			c.Hide();
			
			const threadedParams = {
				lod: params.lod,
				width: params.width,
				offset: params.offset.toArray(),
				resolution: params.resolution,
				worldMatrix: params.transform,
			};
			
			const msg = {
				params: threadedParams,
			};
			
			this.workerPool_.Enqueue(msg, (m) => {
				this._OnResult(c, m);
			});
			
			return c;
		}
		
		RetireChunks(chunks) {
			this.old_.push(...chunks);
		}
		
		_RecycleChunks(chunks) {
			for (let c of chunks) {
				if (!(c.chunk.params_.width in this.pool_)) {
					this.pool_[c.chunk.params_.width] = [];
				}
				
				c.chunk.Destroy();
			}
		}
		
		get Busy() {
			return this.workerPool_.Busy;
		}
		
		Rebuild(chunks) {
			for (let k in chunks) {
				this.workerPool_.Enqueue(chunks[k].chunk.params_);
			}
		}
		
		Update() {
			if (!this.Busy) {
				this._RecycleChunks(this.old_);
				this.old_ = [];
			}
		}
	}
	
	return {
		OceanChunkRebuilder_Threaded: _OceanChunkRebuilder_Threaded
	}
    
})();
