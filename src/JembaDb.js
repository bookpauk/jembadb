'use strict';

const fs = require('fs').promises;

const MemoryTable = require('./MemoryTable');
const ShardedTable = require('./ShardedTable');
const BasicTable = require('./BasicTable');

const LockQueue = require('./LockQueue');
const utils = require('./utils');
const mson = require('./mson');

/* API methods:
lock
unlock

create
drop
truncate
clone

open
openAll
close
closeAll

tableExists
getDbInfo
getDbSize
setMonitoring

select
insert
update
delete

markCorrupted

freeMemory
esc
*/

class JembaDb {
    constructor() {
        this.tableLockMap = new Map();

        this.opened = false;
    }

    /*
    query = {
    (!) dbPath: String, required
        create: Boolean, false,
        softLock: Boolean, false
        ignoreLock: Boolean, false,

        //table open defaults
        tableDefaults: {
            type: 'basic' | 'memory' | 'sharded', default 'basic'
            cacheSize: Number, 5
            cacheShards: Number, 1, for sharded table only
            autoShardSize: Number, 1000000, for sharded table only
            compressed: Number, {0..9}, 0
            recreate: Boolean, false,
            autoRepair: Boolean, false,
            forceFileClosing: Boolean, false,
            typeCompatMode: Boolean, false,
        },
    }
    */
    async lock(query = {}) {
        if (this.opened)
            throw new Error(`Database ${this.dbPath} has already been opened`);

        if (!query.dbPath)
            throw new Error(`'query.dbPath' parameter is required`);

        this.dbPath = query.dbPath;
        if (query.create) {
            await fs.mkdir(this.dbPath, { recursive: true });
        } else {
            await fs.access(this.dbPath);
        }

        //file lock
        try {
            this.fileWatcher = await utils.getFileLock(this.dbPath, query.softLock, query.ignoreLock);
        } catch (e) {
            if (e.message.indexOf('Path locked') === 0) {
                throw new Error(`Database locked: ${this.dbPath}`);
            } else {
                throw e;
            }
        }

        //table list & default settings
        this.table = new Map();
        this.tableOpenDefaults = {};

        if (query.tableDefaults)
            this.tableOpenDefaults = utils.cloneDeep(query.tableDefaults);

        this.opened = true;
    }

    async unlock() {
        if (!this.opened)
            return;

        if (this.monCleanTimer) {
            clearInterval(this.monCleanTimer);
            this.monCleanTimer = null;
        }

        await this.closeAll();

        //release file lock
        await utils.releaseFileLock(this.dbPath, this.fileWatcher);
        this.fileWatcher = null;

        this.opened = false;        

        //console.log('closed');
    }

    _checkOpened() {
        if (!this.opened)
            throw new Error(`Database closed. Use 'db.lock' to lock & open database.`);
    }

    async _checkTable(table) {
        if (await this.tableExists({table})) {
            throw new Error(`Table '${table}' closed`);
        } else {
            throw new Error(`Table '${table}' does not exist`);
        }
    }

    _tableLock(table) {
        let queue = this.tableLockMap.get(table);
        
        if (!queue) {
            queue = new LockQueue(100);
            this.tableLockMap.set(table, queue);
        }

        return queue;
    }

    /*
    query = {
    (*) table: 'tableName',
        quietIfExists: Boolean,
        asSelect: Object, select query,

        type: 'basic' | 'memory' | 'sharded', default 'basic'
        cacheSize: Number, 5
        cacheShards: Number, 1, for sharded table only
        autoShardSize: Number, 1000000, for sharded table only
        compressed: Number, {0..9}, 0
        recreate: Boolean, false,
        autoRepair: Boolean, false,
        forceFileClosing: Boolean, false,
        typeCompatMode: Boolean, false,

    (*) in: 'tableName',
        flag:  Object || Array, {name: 'flag1', check: '(r) => r.id > 10'}
        hash:  Object || Array, {field: 'field1', type: 'string', depth: 11, allowUndef: false}
        index: Object || Array, {field: 'field1', type: 'string', depth: 11, allowUndef: false}
    }
    result = {}
    */
    async create(query = {}) {
        this._checkOpened();

        if ((!query.table && !query.in) || (query.table && query.in))
            throw new Error(`One of 'query.table' or 'query.in' parameters is required, but not both`);

        const table = (query.table ? query.table : query.in);
        await this._tableLock(table).get();
        try {
            query = utils.cloneDeep(query);

            let rows = null;

            if (query.table) {
                const exists = await this.tableExists({table: query.table});
                if (exists && !query.quietIfExists) {
                    throw new Error(`Table '${query.table}' already exists`);
                }

                if (!exists && query.asSelect)
                    rows = await this.select(query.asSelect);
            } else {
                if (await this.tableExists({table: query.in})) {
                    query.table = query.in;
                } else {
                    throw new Error(`Table '${query.in}' does not exist`);
                }            
            }

            //create | open
            query.create = true;
            await this.open(query);

            //asSelect
            if (rows) {
                await this.insert({table: query.table, rows})
            }

            if (query.flag || query.hash || query.index) {
                const tableInstance = this.table.get(query.table);

                await tableInstance.create({
                    quietIfExists: query.quietIfExists,
                    flag: query.flag,
                    hash: query.hash,
                    index: query.index,
                });
            }

            return {};
        } finally {
            this._tableLock(table).ret();
        }
    }

    /*
    query = {
    (*) table: 'tableName',

    (*) in: 'tableName',
        flag:  Object || Array, {name: 'flag1'}
        hash:  Object || Array, {field: 'field1'}
        index: Object || Array, {field: 'field1'}
    }
    result = {}
    */
    async drop(query = {}) {
        this._checkOpened();

        if ((!query.table && !query.in) || (query.table && query.in))
            throw new Error(`One of 'query.table' or 'query.in' parameters is required, but not both`);

        const table = (query.table ? query.table : query.in);
        await this._tableLock(table).get();
        try {
            return await this._drop(query);
        } finally {
            this._tableLock(table).ret();
            this.tableLockMap.delete(table);
        }
    }

    async _drop(query = {}) {
        if (query.table) {
            if (await this.tableExists({table: query.table})) {
                const tableInstance = this.table.get(query.table);
                if (tableInstance && tableInstance.opened) {
                    await tableInstance.close();
                }

                const basePath = `${this.dbPath}/${query.table}`;
                await fs.rm(basePath, { recursive: true, force: true });

                this.table.delete(query.table);
            } else {
                throw new Error(`Table '${query.table}' does not exist`);
            }
        } else {
            if (await this.tableExists({table: query.in})) {
                const tableInstance = this.table.get(query.in);

                if (tableInstance) {                
                    if (query.flag || query.hash || query.index) {
                        await tableInstance.drop({
                            flag: query.flag,
                            hash: query.hash,
                            index: query.index,
                        });
                    }
                } else {
                    throw new Error(`Table '${query.in}' has not been opened yet`);
                }
            } else {
                throw new Error(`Table '${query.in}' does not exist`);
            }
        }

        return {};
    }

    /*
    query = {
    (!) table: 'tableName',
    }
    result = {}
    */
    async truncate(query = {}) {
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);

        const table = query.table;
        await this._tableLock(table).get();
        try {
            const tableInstance = this.table.get(table);
            if (tableInstance) {
                if (tableInstance.type === 'memory') {
                    const newTableInstance = new MemoryTable();

                    const opts = Object.assign({}, this.tableOpenDefaults);
                    await newTableInstance.open(opts);

                    await tableInstance.clone({toTableInstance: newTableInstance, filter: 'nodata'});

                    this.table.set(table, newTableInstance);
                } else {
                    const toTable = `${table}___temporary_truncating`;
                    await fs.rm(`${this.dbPath}/${toTable}`, { recursive: true, force: true });

                    await this._clone({table, toTable, filter: 'nodata'});

                    await this.close({table: toTable});
                    await this._drop(query);

                    await fs.rename(`${this.dbPath}/${toTable}`, `${this.dbPath}/${table}`);
                    await this.open(query);
                }

                return {};
            } else {
                await this._checkTable(query.table);
            }
        } finally {
            this._tableLock(table).ret();
        }
    }


    /*
    query = {
    (!) table: 'tableName',
    (!) toTable: 'tableName2',
        filter: '(r) => true' || 'nodata',
        noMeta: Boolean,
    }
    result = {}
    */
    async clone(query = {}) {
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);
        if (!query.toTable)
            throw new Error(`'query.toTable' parameter is required`);

        const table = query.table;
        await this._tableLock(table).get();
        try {
            return await this._clone(query);
        } finally {
            this._tableLock(table).ret();
        }
    }

    async _clone(query) {
        const tableInstance = this.table.get(query.table);

        if (tableInstance) {
            if (await this.tableExists({table: query.toTable})) {
                throw new Error(`Table '${query.toTable}' already exists`);
            }

            if (tableInstance.type === 'memory') {
                const newTableInstance = new MemoryTable();

                const opts = Object.assign({}, this.tableOpenDefaults);
                await newTableInstance.open(opts);

                await tableInstance.clone(Object.assign({}, query, {toTableInstance: newTableInstance}));

                this.table.set(query.toTable, newTableInstance);
            } else {
                query = utils.cloneDeep(query);
                query.toTablePath = `${this.dbPath}/${query.toTable}`;

                await tableInstance.clone(query);
                await this.open({table: query.toTable});
            }

            return {};
        } else {
            await this._checkTable(query.table);
        }
    }

    async _getTableType(query) {
        let result = 'basic';

        const typePath = `${this.dbPath}/${query.table}/type`;
        if (await utils.pathExists(typePath)) {
            result = await fs.readFile(typePath, 'utf8');
        }

        return result;
    }

    /*
    query = {
    (!) table: 'tableName',
        create: Boolean, false,

        type: 'basic' | 'memory' | 'sharded', default 'basic'
        cacheSize: Number, 5
        cacheShards: Number, 1, for sharded table only
        autoShardSize: Number, 1000000, for sharded table only
        compressed: Number, {0..9}, 0
        recreate: Boolean, false,
        autoRepair: Boolean, false,
        forceFileClosing: Boolean, false,
        typeCompatMode: Boolean, false,
    }
    */
    async open(query = {}) {
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);

        const tableExists = await this.tableExists({table: query.table});
        if (tableExists || query.create) {
            let tableInstance = this.table.get(query.table);

            if (!tableInstance || !tableInstance.opened) {
                let type = query.type;
                if (tableExists)
                    type = await this._getTableType(query);

                if (type === 'memory') {
                    tableInstance = new MemoryTable();
                } else if (type === 'sharded') {
                    tableInstance = new ShardedTable();
                } else {
                    tableInstance = new BasicTable();
                }
                this.table.set(query.table, tableInstance);

                const opts = Object.assign({}, this.tableOpenDefaults, query);
                opts.tablePath = `${this.dbPath}/${query.table}`;
                await tableInstance.open(opts);
            }
        } else {
            throw new Error(`Table '${query.table}' does not exist`);
        }
    }


    async _getTableList() {
        const result = [];
        const files = await fs.readdir(this.dbPath, { withFileTypes: true });

        for (const table of this.table.keys()) {
            result.push(table);
        }

        for (const file of files) {
            if (file.isDirectory()) {
                if (file.name.indexOf('___temporary_recreating') >= 0 ||
                    file.name.indexOf('___temporary_truncating') >= 0)
                    continue;

                const tableInstance = this.table.get(file.name);
                
                if (!tableInstance)
                    result.push(file.name);
            }
        }

        return result;
    }

    /*
    query = {
        exclude: String || Array, do not open excluded tables
        //table open params
        type: 'basic' | 'memory' | 'sharded', default 'basic'
        cacheSize: Number, 5
        cacheShards: Number, 1, for sharded table only
        autoShardSize: Number, 1000000, for sharded table only
        compressed: Number, {0..9}, 0
        recreate: Boolean, false,
        autoRepair: Boolean, false,
        forceFileClosing: Boolean, false,
        typeCompatMode: Boolean, false,
    }
    */
    async openAll(query = {}) {
        this._checkOpened();

        const tables = await this._getTableList();
        let excluded = new Set();

        if (query.exclude) {
            excluded = new Set(utils.paramToArray(query.exclude));

            query = utils.cloneDeep(query);
            delete query.exclude;
        }

        //sequentially
        for (const table of tables) {
            if (excluded.has(table))
                continue;

            this._checkOpened();
            await this.open(Object.assign({}, query, {table}));
        }
    }

    /*
    query = {
    (!) table: 'tableName',
    }
    */
    async close(query = {}) {
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);

        if (await this.tableExists({table: query.table})) {
            let tableInstance = this.table.get(query.table);

            if (tableInstance) {
                await tableInstance.close();
            }

            this.table.delete(query.table);
        } else {
            throw new Error(`Table '${query.table}' does not exist`);
        }
    }

    async closeAll() {
        this._checkOpened();

        const promises = [];
        for (const table of this.table.keys()) {
            promises.push(this.close({table}));
        }
        await Promise.all(promises);
    }

    /*
    query = {
    (!) table: 'tableName'
    },
    result = Boolean
    */
    async tableExists(query = {}) {
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);

        if (this.table.has(query.table))
            return true;

        if (await utils.pathExists(`${this.dbPath}/${query.table}`))
            return true;

        return false;
    }

    /*
    query = {
        table: 'tableName'
    },
    result = {
        dbPath: String,
        tableName1: {opened: Boolean, ...},
        tableName2: {opened: Boolean, ...},
        ...
    }
    */
    async getDbInfo(query = {}) {
        this._checkOpened();

        const tables = await this._getTableList();

        const result = {dbPath: this.dbPath};

        result.monitoring = {
            enabled: this.monitoringEnabled,
            table: this.monitoringTable,
            interval: this.monitoringInterval,
            maxQueryLength: this.monitoringMaxQueryLength,
        };

        for (const table of tables) {
            if (!query.table || (query.table && table == query.table)) {
                const tableInstance = this.table.get(table);
                if (tableInstance && tableInstance.opened) {
                    result[table] = await tableInstance.getMeta();
                    result[table].opened = true;
                } else {
                    result[table] = {opened: false};
                }
            }
        }
        return utils.cloneDeep(result);
    }

    /*
    result = {
        total: Number,
        tables: {
            tableName1: Number,
            tableName2: Number,
            ...
        }
    }
    */
    async getDbSize() {
        this._checkOpened();

        const dirs = await fs.readdir(this.dbPath, { withFileTypes: true });

        const result = {total: 0, tables: {}};
        for (const dir of dirs) {
            if (dir.isDirectory()) {
                const table = dir.name;
                const tablePath = `${this.dbPath}/${table}`;
                const files = await fs.readdir(tablePath, { withFileTypes: true });

                if (!result.tables[table])
                    result.tables[table] = 0;

                for (const file of files) {
                    if (file.isFile()) {
                        let size = 0;
                        try {
                            size = (await fs.stat(`${tablePath}/${file.name}`)).size;
                        } catch(e) {
                            //
                        }
                        result.tables[table] += size;
                        result.total += size;
                    }
                }
            }
        }

        return result;
    }

    /*
    query = {
        enable: Boolean, default false
        table: 'tableName', default '__monitoring'
        interval: Number, minutes, default 15
        maxQueryLength: Number, default 200
    }
    result = {}
    */
    async setMonitoring(query = {}) {
        const apiMethods = [
            'create', 'drop', 'truncate', 'clone', 'open', 'openAll', 'close', 'closeAll',
            'select', 'insert', 'update', 'delete',
        ];

        if (query.interval && typeof(query.interval) != 'number')
            throw new Error(`query.interval must be of type 'number'`);

        this.monitoringInterval = query.interval || 15;

        if (!utils.hasProp(this, 'monitoringMaxQueryLength'))
            this.monitoringMaxQueryLength = 200;

        if (utils.hasProp(query, 'maxQueryLength')) {
            if (typeof(query.maxQueryLength) != 'number')
                throw new Error(`query.maxQueryLength must be of type 'number'`);

            this.monitoringMaxQueryLength = query.maxQueryLength;
        }

        if (!this.monitoringTable)
            this.monitoringTable = '__monitoring';

        if (!this.monitoringId)
            this.monitoringId = 1;

        if (query.table && typeof(query.table) != 'string')
            throw new Error(`query.table must be of type 'string'`);

        if (query.enable) {
            if (!this.monitoringEnabled) {

                if (query.table)
                    this.monitoringTable = query.table;

                //close monitoring table
                if (await this.tableExists({table: this.monitoringTable}))
                    await this.close({table: this.monitoringTable});

                //create monitoring table
                /* records:
                    {
                        id: Number,
                        method: String,
                        query: String,
                        error: String,
                        timeBegin: Number,
                        timeEnd: Number,
                    }
                */
                await this.create({
                    table: this.monitoringTable,
                    create: true,
                    type: 'memory',
                    flag: {name: 'executed', check: `(r) => (r.timeEnd === 0)`}
                });

                //save original methods
                if (!this.origMethods) {
                    this.origMethods = {};
                    for (const method of apiMethods)
                        this.origMethods[method] = this[method].bind(this);
                }

                //create monitoring methods
                if (!this.monMethods) {
                    this.monMethods = {};
                    for (const method of apiMethods) {
                        this.monMethods[method] = (async(methodQuery) => {
                            let monTableInstance;
                            let monRec = {};
                            let error = '';

                            if (this.monitoringEnabled) {
                                monTableInstance = this.table.get(this.monitoringTable);
                                monTableInstance = (monTableInstance && !monTableInstance.closed ? monTableInstance : undefined);

                                monRec = {
                                    id: this.monitoringId++,
                                    method,
                                    query: (this.monitoringMaxQueryLength ? mson.encode(methodQuery).substring(0, this.monitoringMaxQueryLength) : ''),
                                    error,
                                    timeBegin: Date.now(),
                                    timeEnd: 0,
                                };

                                if (monTableInstance) {
                                    try {
                                        await monTableInstance.insert({rows: [monRec]});
                                    } catch (e) {
                                        //quiet, origMethod must be called even if monitoring error occured
                                    }
                                }
                            }

                            try {
                                return await this.origMethods[method](methodQuery);//original
                            } catch (e) {
                                error = e.message;
                                throw e;
                            } finally {
                                if (this.monitoringEnabled) {
                                    monTableInstance = this.table.get(this.monitoringTable);
                                    monTableInstance = (monTableInstance && !monTableInstance.closed ? monTableInstance : undefined);
                                    if (monTableInstance) {
                                        monRec.error = error;
                                        monRec.timeEnd = Date.now();

                                        await monTableInstance.insert({replace: true, rows: [monRec]});
                                    }
                                }
                            }
                        }).bind(this);
                    }
                }

                //change original methods to monitoring
                for (const method of apiMethods)
                    this[method] = this.monMethods[method];

                //clean timeout
                if (this.monCleanTimer) {
                    clearInterval(this.monCleanTimer);
                    this.monCleanTimer = null;
                }

                this.monCleanTimer = setInterval(async() => {
                    if (this.monCleaning || !this.monitoringEnabled)
                        return;

                    this.monCleaning = true;
                    try {
                        let monTableInstance = this.table.get(this.monitoringTable);
                        monTableInstance = (monTableInstance && !monTableInstance.closed ? monTableInstance : undefined);

                        if (monTableInstance) {
                            const delDate = new Date();
                            delDate.setMinutes(delDate.getMinutes() - this.monitoringInterval);

                            try {
                                await monTableInstance.delete({
                                    where: `
                                        @@iter(@all(), (row) => {
                                            if (row.timeBegin >= ${this.esc(delDate.getTime())}) {
                                                return;
                                            } else {
                                                return (row.timeEnd > 0 && row.timeEnd < ${this.esc(delDate.getTime())});
                                            }
                                        });
                                    `
                                });
                            } catch (e) {
                                //console.error(e);//silent
                            }
                        }
                    } finally {
                        this.monCleaning = false;
                    }
                }, 60*1000);//every minute

                this.monitoringEnabled = true;
            } else {
                throw new Error('Query monitoring already enabled');
            }
        } else if (this.monitoringEnabled) {
            if (this.monCleanTimer) {
                clearInterval(this.monCleanTimer);
                this.monCleanTimer = null;
            }

            //change monitoring methods to original
            for (const method of apiMethods)
                this[method] = this.origMethods[method];

            this.monitoringEnabled = false;

            //close monitoring table
            await this.close({table: this.monitoringTable});
        }
    }

    /*
    query = {
    (!) table: 'tableName',
        shards: ['shard1', 'shard2', ...] || '(s) => (s == 'shard1')', //for sharded table only
        persistent: Boolean,//for sharded table only, do not unload shard while persistent == true
        count: Boolean,
        rawResult: Boolean,
        where: `@@index('field1', 10, 20)`,
        distinct: 'fieldName' || Array,
        group: {byField: 'fieldName' || Array, byExpr: '(r) => groupingValue', countField: 'fieldName'},
        map: '(r) => ({id1: r.id, ...})',
        sort: '(a, b) => a.id - b.id',
        limit: 10,
        offset: 10,
        joinById: {table: 'tableName', on: 'fieldNameToJoinOn', out: 'fieldNameToPutJoinResult', map: '(r) => r.name'} || Array,
    }
    result = Array
    */
    async select(query = {}) {
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);

        const tableInstance = this.table.get(query.table);
        if (tableInstance) {
            //select
            const resultRows = await tableInstance.select(query);

            //joinById
            if (query.joinById) {
                const joinList = (Array.isArray(query.joinById) ? query.joinById : [query.joinById]);

                for (const join of joinList) {
                    if (!join.table)
                        throw new Error(`'joinById.table' parameter is required`);
                    if (!join.on)
                        throw new Error(`'joinById.on' parameter is required`);


                    const joinTableInstance = this.table.get(join.table);
                    if (joinTableInstance) {
                        const on = join.on;
                        const ids = resultRows.map((r) => r[on]);

                        const joinRows = await joinTableInstance.select({where: `@@id(${this.esc(ids)})`});

                        let mapFunc = null;
                        if (join.map) {
                            mapFunc = new Function(`'use strict'; return ${join.map}`)();
                        }

                        const idMap = new Map();
                        for (const row of joinRows) {
                            idMap.set(row.id, (mapFunc ? mapFunc(row) : row));
                        }

                        const out = (join.out ? join.out : `table_${join.table}`);
                        for (const row of resultRows) {
                            row[out] = idMap.get(row[on]);
                        }
                    } else {
                        await this._checkTable(join.table);
                    }
                }
            }

            return resultRows;
        } else {
            await this._checkTable(query.table);
        }
    }

    /*
    query = {
    (!) table: 'tableName',
        ignore: Boolean,
        replace: Boolean,
        shardGen: '(r) => r.date',//for sharded table only
    (!) rows: Array,
    }
    result = {
    (!) inserted: Number,
    (!) replaced: Number,
    (!) lastInsertId: Number,
    }
    */
    async insert(query = {}) {
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);

        const tableInstance = this.table.get(query.table);
        if (tableInstance) {
            return await tableInstance.insert(query);
        } else {
            await this._checkTable(query.table);
        }
    }

    /*
    query = {
    (!) table: 'tableName',
    (!) mod: '(r) => r.count++',
        shards: ['shard1', 'shard2', ...] || '(s) => (s == 'shard1')', //for sharded table only
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
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);

        const tableInstance = this.table.get(query.table);
        if (tableInstance) {
            return await tableInstance.update(query);
        } else {
            await this._checkTable(query.table);
        }
    }

    /*
    query = {
    (!) table: 'tableName',
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
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);

        const tableInstance = this.table.get(query.table);
        if (tableInstance) {
            return await tableInstance.delete(query);
        } else {
            await this._checkTable(query.table);
        }
    }

    /*
    query = {
    (!) table: 'tableName',
        message: String,
    }
    result = {}
    */
    async markCorrupted(query = {}) {
        this._checkOpened();

        if (!query.table)
            throw new Error(`'query.table' parameter is required`);

        const tableInstance = this.table.get(query.table);
        if (tableInstance) {
            await tableInstance.markCorrupted(query);
            await this.close(query);
            return {};
        } else {
            await this._checkTable(query.table);
        }
    }

    async freeMemory() {
        utils.freeMemory();
    }

    esc(obj) {
        return utils.esc(obj);
    }
}

module.exports = JembaDb;