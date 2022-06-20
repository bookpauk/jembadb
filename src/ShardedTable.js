'use strict';
/*
    Total maximum rec count is unlimited.

    Limitations:
    - no rec.id while insert
    - rec.shard field required while insert
    - no unique hashes and indexes
    - maximum rec count per one shard is ~16000000 (limitation of JS Map)
    - possible unexpected behavior for select with limit,offset params
*/
const fs = require('fs').promises;
const utils = require('./utils');
const LockQueue = require('./LockQueue');

const BasicTable = require('./BasicTable');

const shardCountStep = 20*1000*1000;//must be greater than 16M
const maxFreeShardNumsLength = 100;
const maxAutoShardListLength = 1000;
const autoShardName = '___auto';

class ShardedTable {
    constructor() {
        this.type = 'sharded';

        this.autoIncrement = 0;
        this.fileError = '';

        this.lock = new LockQueue(100);
        this.tableLockMap = new Map();
        this.cachedShardLock = new LockQueue(100);

        this.metaTable = null; //basic table
        this.infoShard = {id: '', count: 0};

        /*
        {
            id: String,//shard
            num: Number,
            count: Number,
        }
        */
        this.shardList = new Map();
        this.shardListTable = null;//basic table

        this.shardLockList = new Map; //{lock: Number, pers: Number}

        this.openedShardTables = new Map();//basic tables
        this.openedShardNames = new Set();
        this.closableShardNames = new Set();
        this.cachedShardNames = new Set();

        this.freeShardNums = [];

        this.autoShard = {
            step: 0,
            list: [],//{shard: String, count: Number}
        };

        this.opened = false;
        this.closed = false;
        this.changedTables = [];

        //table open query
        this.openQuery = {};

        //table options defaults
        this.cacheShards = 1;
        this.autoShardSize = 1000000;
    }

    _checkErrors() {
        if (this.fileError)
            throw new Error(this.fileError);

        if (this.closed)
            throw new Error('Table closed');

        if (!this.opened)
            throw new Error('Table has not been opened yet');
    }

    async _recreateTable() {
        //TODO
    }

    async _loadMeta() {
        this.metaTable = new BasicTable();
        await this.metaTable.open({tablePath: `${this.tablePath}/meta`});

        this.shardListTable = new BasicTable();
        await this.shardListTable.open({tablePath: `${this.tablePath}/shards`});

        const rows = await this.shardListTable.select({});//all
        for (const row of rows) {
            if (row.id !== '') {
                this.shardList.set(row.id, row);
            } else {
                this.infoShard = row;
            }
        }
    }

    async _saveShardRec(shardRec) {
        await this.shardListTable.insert({rows: [shardRec], replace: true});
        this.changedTables.push(this.shardListTable);
        this._checkTables(); //no await
    }

    async _delShardRec(shardRec) {
        await this.shardListTable.delete({where: `@@id(${utils.esc(shardRec.id)})`});
        this.changedTables.push(this.shardListTable);
        this._checkTables(); //no await
    }

    _shardTablePath(num) {
        if (num < 1000000)
            return `${this.tablePath}/s${num.toString().padStart(6, '0')}`;
        else
            return `${this.tablePath}/s${num.toString().padStart(12, '0')}`;
    }

    _getFreeShardNum() {
        if (!this.freeShardNums.length) {
            this.freeShardNums = [];
            const nums = new Set();
            for (const shardRec of this.shardList.values()) {
                nums.add(shardRec.num);
            }

            let i = 0;
            while (this.freeShardNums.length < maxFreeShardNumsLength) {
                if (!nums.has(i))
                    this.freeShardNums.push(i);
                i++;
            }
        }

        return this.freeShardNums.shift();
    }

    _tableLock(table) {
        let queue = this.tableLockMap.get(table);
        
        if (!queue) {
            queue = new LockQueue(100);
            this.tableLockMap.set(table, queue);
        }

        return queue;
    }

    _checkCachedShardLock() {
        if (this.cachedShardNames.size <= this.cacheShards) {
            this.cachedShardLock.ret();
            return;
        }

        if (this.cachedShardLock.freed)
            this.cachedShardLock.get();
    }

    _updateShardLockList(shard, lockN = 0, persN = 0) {
        let lockRec = this.shardLockList.get(shard);

        if (!lockRec) {
            lockRec = {lock: 0, pers: 0};
            this.shardLockList.set(shard, lockRec);
        }

        lockRec.lock += lockN;
        if (lockRec.lock < 0) lockRec.lock = 0;
        
        lockRec.pers += persN;
        if (lockRec.pers < 0) lockRec.pers = 0;

        if (lockRec.pers > 0) {
            this.closableShardNames.delete(shard);
            this.cachedShardNames.delete(shard);
            this._checkCachedShardLock();
        } else {
            if (lockRec.lock > 0) {
                this.closableShardNames.delete(shard);
            } else {
                this.closableShardNames.add(shard);
            }
            this.cachedShardNames.add(shard);
            this._checkCachedShardLock();
        }

    }

    async _closeShards(closeAll = false) {
        if (closeAll) {
            for (const [shard, table] of this.openedShardTables) {
                await table.close();
                this.openedShardTables.delete(shard);
                this.openedShardNames.delete(shard);
            }
        } else {
            if (this.cachedShardNames.size <= this.cacheShards)
                return;

            for (const shard of this.closableShardNames) {
                const tabLock = this._tableLock(shard);

                await tabLock.get();                
                try {
                    if (this.cachedShardNames.size > this.cacheShards) {
                        if (this.closableShardNames.has(shard) && this.openedShardNames.has(shard)) {
                            const table = this.openedShardTables.get(shard);

                            await table.close();

                            this.openedShardTables.delete(shard);
                            this.openedShardNames.delete(shard);
                            this.cachedShardNames.delete(shard);
                            this._checkCachedShardLock();
                        }
                        this.closableShardNames.delete(shard);
                    } else {
                        break;
                    }
                } finally {
                    tabLock.ret();
                }
            }
        }
    }

    async _delShards(shardArr) {
        /*for (const shard of shardArr) {
            if (this.openedShardNames.has(shard)) {
                const table = this.openedShardTables.get(shard);

                await table.close();

                this.openedShardTables.delete(shard);
                this.openedShardNames.delete(shard);
            }

            const shardRec = this.shardList.get(shard);
            if (!shardRec)
                throw new Error('Something wrong: trying to delete not existing shard');

            if (shardRec.count)
                throw new Error(`Something wrong: trying to delete not empty shard: ${JSON.stringify(shardRec)}`);

            await this._delShardRec(shardRec);
            this.shardList.delete(shard);

            await fs.rmdir(this._shardTablePath(shardRec.num), { recursive: true });
        }*/
    }

    async _lockShard(shard) {
        const tabLock = this._tableLock(shard);

        await tabLock.get();
        try {
            if (this.openedShardNames.has(shard)) {
                this._updateShardLockList(shard, 1, 0);
                return this.openedShardTables.get(shard);
            }

            await this.cachedShardLock.wait();

            let shardRec = this.shardList.get(shard);
            let isNew = !shardRec;
            if (isNew) {
                shardRec = {
                    id: shard,
                    num: this._getFreeShardNum(),
                    count: 0,
                };

                await this._saveShardRec(shardRec);
                this.shardList.set(shard, shardRec);
            }

            const newTable = new BasicTable();

            const query = utils.cloneDeep(this.openQuery);
            query.tablePath = this._shardTablePath(shardRec.num);

            await newTable.open(query);

            if (isNew)
                newTable.autoIncrement = shardCountStep*shardRec.num;

            this.openedShardTables.set(shard, newTable);
            this.openedShardNames.add(shard);
            this._updateShardLockList(shard, 1, 0);

            return newTable;
        } finally {
            tabLock.ret();
        }
    }

    async _unlockShard(shard) {
        this._updateShardLockList(shard, -1, 0);

        await this._closeShards();
    }

    /*
    query: {
        tablePath: String,
        cacheSize: Number,
        cacheShards: Number, 1, for sharded table only
        compressed: Number, 0..9
        recreate: Boolean, false,
        autoRepair: Boolean, false,
        forceFileClosing: Boolean, false,
        typeCompatMode: Boolean, false,
    }
    */
    async open(query = {}) {
        if (this.opening)
            throw new Error('Table open in progress');

        this.opening = true;
        //console.log(query);
        try {
            if (this.opened)
                throw new Error('Table has already been opened');
            if (this.closed)
                throw new Error('Table instance has been destroyed. Please create a new one.');

            //opening
            if (!query.tablePath)
                throw new Error(`'query.tablePath' parameter is required`);

            this.tablePath = query.tablePath;
            this.cacheShards = query.cacheShards || this.cacheShards;
            this.autoShardSize = query.autoShardSize || this.autoShardSize;

            this.openQuery = query;            

            let create = true;
            if (await utils.pathExists(this.tablePath)) {
                create = false;
            } else {
                await fs.mkdir(this.tablePath, { recursive: true });
            }

            //check table version
            const statePath = `${this.tablePath}/state`;
            const typePath = `${this.tablePath}/type`;
            if (create) {
                await fs.writeFile(typePath, this.type);
                await fs.writeFile(statePath, '1');
            } else {
                let type = null;
                if (await utils.pathExists(typePath)) {
                    type = await fs.readFile(typePath, 'utf8');
                    if (type !== this.type)
                        throw new Error(`Wrong table type '${type}', expected '${this.type}'`);
                } else {
                    if (query.typeCompatMode) {
                        await fs.writeFile(typePath, this.type);
                    } else {
                        throw new Error(`Table type file not found`);
                    }
                }
            }

            //check table state
            let state = null;
            if (await utils.pathExists(statePath)) {
                state = await fs.readFile(statePath, 'utf8');
            }

            if (this.recreate) {
                await this._recreateTable();
                state = '1';
            }

            //load
            try {
                if (state === '1') {
                    await this._loadMeta();
                } else {
                    throw new Error('Table corrupted')
                }
            } catch(e) {
                if (this.autoRepair) {
                    console.error(e.message);
                    await this._recreateTable();
                } else {
                    throw e;
                }

                await this._loadMeta();
            }

            this.opened = true;
        } catch(e) {
            await this.close();
            throw new Error(`Open table (${query.tablePath}): ${e.message}`);
        } finally {
            this.opening = false;
        }
    }

    async close() {
        if (this.closed)
            return;

        this.opened = false;
        this.closed = true;

        await this.lock.get();
        try {
            await this.metaTable.close();
            await this.shardListTable.close();
            await this._closeShards(true);

            while (this.checkingTables) {
                await utils.sleep(10);
            }

            if (this.fileError) {
                try {
                    await this._saveState('0');
                } catch(e) {
                    //
                }
            }
        } finally {
            this.lock.ret();
        }
    }

    _checkUniqueMeta(query) {
        if (query.hash) {
            for (const hash of utils.paramToArray(query.hash)) {
                if (hash.unique)
                    throw new Error(`Unique hashes are forbidden for this table type (${this.type})`);
            }
        }

        if (query.index) {
            for (const index of utils.paramToArray(query.index)) {
                if (index.unique)
                    throw new Error(`Unique indexes are forbidden for this table type (${this.type})`);
            }
        }
    }

    /*
    query = {
        quietIfExists: Boolean,
        flag:  Object || Array, {name: 'flag1', check: '(r) => r.id > 10'}
        hash:  Object || Array, {field: 'field1', type: 'string', depth: 11, allowUndef: false}
        index: Object || Array, {field: 'field1', type: 'string', depth: 11, allowUndef: false}
    }
    result = {}
    */
    async create(query) {
        this._checkErrors();

        await this.lock.get();
        try {
            this._checkUniqueMeta(query);

            for (const shard of this.shardList.keys()) {                
                const table = await this._lockShard(shard);
                try {
                    await table.create(query);
                } finally {
                    await this._unlockShard(shard);
                }

                this.changedTables.push(table);
                this._checkTables(); //no await
            }

            const result = await this.metaTable.create(query);
            
            this.changedTables.push(this.metaTable);
            this._checkTables(); //no await

            return result;
        } finally {
            this.lock.ret();
        }
    }

    /*
    query = {
        flag:  Object || Array, {name: 'flag1'}
        hash:  Object || Array, {field: 'field1'}
        index: Object || Array, {field: 'field1'}
    }
    result = {}
    */
    async drop(query) {
        this._checkErrors();

        await this.lock.get();
        try {
            for (const shard of this.shardList.keys()) {
                const table = await this._lockShard(shard);
                try {
                    await table.drop(query);
                } finally {
                    await this._unlockShard(shard);
                }

                this.changedTables.push(table);
                this._checkTables(); //no await
            }

            const result = await this.metaTable.drop(query);

            this.changedTables.push(this.metaTable);
            this._checkTables(); //no await

            return result;
        } finally {
            this.lock.ret();
        }
    }

    /*
    result = {
        type: String,
        flag:  Array, [{name: 'flag1', check: '(r) => r.id > 10'}, ...]
        hash:  Array, [{field: 'field1', type: 'string', depth: 11, allowUndef: false}, ...]
        index: Array, [{field: 'field1', type: 'string', depth: 11, allowUndef: false}, ...]
        shardList: [{shard: 'string', num: 1, persistent: false, count: 10}, ...]
    }
    */
    async getMeta() {
        const result = await this.metaTable.getMeta();
        result.type = this.type;
        result.shardList = [];
        for (const shardRec of this.shardList.values()) {
            const lock = this.shardLockList.get(shardRec.id);

            result.shardList.push({
                shard: shardRec.id,
                num: shardRec.num,
                persistent: (lock ? lock.pers : 0),
                count: shardRec.count,
            });
        }
        result.count = this.infoShard.count;

        return result;
    }

    _getOpenedShardsFirst(shardsIter) {
        const shards = [];
        const tailShards = [];

        for (const shard of shardsIter) {
            if (this.openedShardNames.has(shard))
                shards.push(shard);
            else
                tailShards.push(shard);
        }

        return shards.concat(tailShards);
    }

    /*
    query = {
        shards: ['shard1', 'shard2', ...] || '(s) => (s == 'shard1')',
        persistent: Boolean,//do not unload query.shards while persistent == true
        count: Boolean,
        where: `@@index('field1', 10, 20)`,
        distinct: 'fieldName' || Array,
        group: {byField: 'fieldName' || Array, byExpr: '(r) => groupingValue', countField: 'fieldName'},
        map: '(r) => ({id1: r.id, ...})',
        sort: '(a, b) => a.id - b.id',
        limit: 10,
        offset: 10,
    }
    result = Array
    */
    async select(query = {}) {
        this._checkErrors();

        //query.shards
        let selectedShards = [];
        if (!query.shards) {
            selectedShards = this.shardList.keys();
        } else {
            if (Array.isArray(query.shards)) {
                for (const shard of query.shards) {
                    if (this.shardList.get(shard))
                        selectedShards.push(shard);
                }
            } else if (typeof(query.shards) === 'string') {
                const shardTestFunc = new Function(`'use strict'; return ${query.shards}`)();
                for (const shard of this.shardList.keys()) {
                    if (shardTestFunc(shard))
                        selectedShards.push(shard);
                }
            } else {
                throw new Error('Uknown query.shards param type');
            }
        }


        const result = [];
        //select
        if (selectedShards.length) {
            //opened shards first
            selectedShards = this._getOpenedShardsFirst(selectedShards);

            for (const shard of selectedShards) {
                const table = await this._lockShard(shard);
                try {
                    result.push(await table.select(query));
                } finally {
                    await this._unlockShard(shard);
                }
            }
        }

        return [].concat(...result);
    }

    _genAutoShard() {
        const a = this.autoShard;
        while (a.list.length) {
            const last = a.list[a.list.length - 1];

            last.count--;
            if (last.count <= 0)
                a.list.pop();

            const shardRec = this.shardList.get(last.shard);
            
            if (!shardRec || shardRec.count < this.autoShardSize) {
                return last.shard;//return generated shard
            } else if (last.count > 0) {
                a.list.pop();
            }
        }

        //step 0 - check existing shards, opened shards to the end
        if (a.step === 0 && !a.list.length) {
            const opened = [];
            for (const [shard, shardRec] of this.shardList) {
                if (shardRec.count < this.autoShardSize) {

                    const listRec = {shard, count: this.autoShardSize - shardRec.count};

                    if (this.openedShardNames.has(shard)) {
                        opened.push(listRec);
                    } else {
                        a.list.push(listRec);
                    }
                }
            }

            a.list = a.list.concat(opened);

            a.step++;
        }

        //step 1 - generate new shard name, all existing are full
        if (a.step === 1 && !a.list.length) {
            const exists = new Set(this.shardList.keys());
            let i = 0;
            while (a.list.length < maxAutoShardListLength) {
                i++;
                const shard = `auto_${i}`;
                if (!exists.has(shard))
                    a.list.push({shard, count: this.autoShardSize});
            }

            a.list = a.list.reverse();
        }

        return this._genAutoShard();
    }

    /*
    query = {
        shardGen: '(r) => r.date',
    (!) rows: Array,
    }
    result = {
    (!) inserted: Number,
    (!) replaced: Number,//always 0
    }
    */
    async insert(query = {}) {
        this._checkErrors();

        await this.lock.get();
        try {
            if (!Array.isArray(query.rows)) {
                throw new Error('query.rows must be an array');
            }

            let shardGen = null;
            if (query.shardGen)
                shardGen = new Function(`'use strict'; return ${query.shardGen}`)();

            const rows = utils.cloneDeep(query.rows);
            //checks & shardedRows
            const shardedRows = new Map();
            for (const row of rows) {
                if (utils.hasProp(row, 'id'))
                    throw new Error(`row.id (${row.id}) use is not allowed for this table type (${this.type}) while insert`);

                if (!utils.hasProp(row, 'shard')) {
                    if (shardGen)
                        row.shard = shardGen(row);
                    else
                        throw new Error(`No row.shard field found for row: ${JSON.stringify(row)}`);
                }

                if (row.shard === '' || typeof(row.shard) !== 'string') 
                    throw new Error(`Wrong row.shard field value: '${row.shard}' for row: ${JSON.stringify(row)}`);

                //auto sharding
                if (row.shard === autoShardName)
                    row.shard = this._genAutoShard();

                let r = shardedRows.get(row.shard);
                if (!r) {
                    r = [];
                    shardedRows.set(row.shard, r);
                }
                r.push(row);
            }

            const result = {inserted: 0, replaced: 0};

            //opened shards first
            const shards = this._getOpenedShardsFirst(shardedRows.keys());

            //inserting
            for (const shard of shards) {
                //insert
                const rows = shardedRows.get(shard);

                let shardCount = 0;
                const table = await this._lockShard(shard);
                try {
                    const insResult = await table.insert({rows});
                    this.changedTables.push(table);
                    result.inserted += insResult.inserted;
                    shardCount = table.rowsInterface.getAllIdsSize();
                } finally {
                    await this._unlockShard(shard);
                }

                const shardRec = this.shardList.get(shard);
                this.infoShard.count -= shardRec.count;
                shardRec.count = shardCount;
                this.infoShard.count += shardCount;
                await this._saveShardRec(shardRec);
                await this._saveShardRec(this.infoShard);
            }

            return result;
        } finally {
            this._checkTables(); //no await
            this.lock.ret();
        }
    }

    /*
    query = {
    (!) mod: '(r) => r.count++',
        where: `@@index('field1', 10, 20)`,
        sort: '(a, b) => a.id - b.id',
        limit: 10,
        offset: 10,
    }
    result = {
    (!) updated: Number,
    }
    */
    async update(query = {}) {
    }

    /*
    query = {
        where: `@@index('field1', 10, 20)`,
        sort: '(a, b) => a.id - b.id',
        limit: 10,
        offset: 10,
    }
    result = {
    (!) deleted: Number,
    }
    */
    async delete(query = {}) {
        //if deleted > 0
        this.autoShard.step = 0;
    }        

    /*
    query = {
        message: String,
    }
    result = {}
    */
    async markCorrupted(query = {}) {
        this.fileError = query.message || 'Table corrupted';
        await this.close();

        return {};
    }

    /*
    query = {
    (!) toTablePath: String,
        filter: '(r) => true' || 'nodata',
        noMeta: Boolean,
    }
    result = {}
    */
    async clone(query = {}) {
    }

    async _saveState(state) {
        await fs.writeFile(`${this.tablePath}/state`, state);
    }

    async _checkTables() {
        this.needCheckTables = true;
        if (this.checkingTables)
            return;

        try {
            this._checkErrors();
        } catch(e) {
            return;
        }

        this.checkingTables = true;
        try {
            await utils.sleep(0);

            while (this.needCheckTables) {
                this.needCheckTables = false;

                while (this.changedTables.length) {

                    const len = this.changedTables.length;
                    let i = 0;
                    while (i < len) {
                        const table = this.changedTables[i];
                        i++;

                        while (table.savingChanges) {
                            if (this.changedTables.indexOf(table, i) > 0)
                                break;
                            await utils.sleep(2);
                        }

                        if (table.fileError) {
                            this.fileError = table.fileError;
                            await this._saveState('0');
                            return;
                        }
                    }

                    this.changedTables = this.changedTables.slice(i);
                }
            }
        } catch(e) {
            console.error(e.message);
            this.fileError = e.message;
        } finally {
            this.checkingTables = false;
        }
    }

}

module.exports = ShardedTable;
