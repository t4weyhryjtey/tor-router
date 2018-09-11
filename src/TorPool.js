/* From http://stackoverflow.com/questions/1985260/javascript-array-rotate */
Array.prototype.rotate = (function() {
    // save references to array functions to make lookup faster
    var push = Array.prototype.push,
        splice = Array.prototype.splice;

    return function(count) {
        var len = this.length >>> 0, // convert to uint
            count = count >> 0; // convert to int

        // convert count to value in range [0, len)
        count = ((count % len) + len) % len;

        // use splice.call() instead of this.splice() to make function generic
        push.apply(this, splice.call(this, 0, count));
        return this;
    };
})();

const path = require('path');
const fs = require('fs');

const { EventEmitter } = require('eventemitter3');
const Promise = require("bluebird");
const _ = require('lodash');

const nanoid = require('nanoid');
const WeightedList = require('js-weighted-list');

const TorProcess = require('./TorProcess');

Promise.promisifyAll(fs);

class TorPool extends EventEmitter {
	constructor(tor_path, default_config, data_directory, load_balance_method, granax_options, logger) {
		if (!data_directory)
			throw new Error('Invalid "data_directory"');
		super();
		this._instances = [];
		this._default_tor_config = default_config;
		this.data_directory = data_directory;
		this.load_balance_method = load_balance_method;
		this.tor_path = tor_path;
		this.logger = logger || require('./winston-silent-logger');
		this.granax_options = granax_options;
	}

	get group_names() {
		return new Set(_.uniq(_.flatten(this.instances.map((instance) => instance.instance_group).filter(Boolean))).sort());
	}
	
	add_instance_to_group(group, instance) {
		instance.definition.Group = _.union(instance.instance_group, [group]);
	}

	add_instance_to_group_by_name(group, instance_name) {
		let instance = this.instance_by_name(instance_name);

		if (!instance) throw new Error(`Instance "${instance_name}" not found`);

		return this.add_instance_to_group(group, instance);
	}

	add_instance_to_group_at(group, instance_index) {
		let instance = this.instance_at(instance_index);

		if (!instance) throw new Error(`Instance at "${instance_index}" not found`);

		return this.add_instance_to_group(group, instance);
	}

	remove_instance_from_group(group, instance) {
		_.remove(instance.definition.Group, (g) => g === group);
	}

	remove_instance_from_group_by_name(group, instance_name) {
		let instance = this.instance_by_name(instance_name);

		if (!instance) throw new Error(`Instance "${instance_name}" not found`);

		return this.remove_instance_from_group(group, instance);
	}

	remove_instance_from_group_at(group, instance_index) {
		let instance = this.instance_at(instance_index);

		if (!instance) throw new Error(`Instance at "${instance_index}" not found`);

		return this.remove_instance_from_group(group, instance);
	}

	get groups() {
		let groupHandler = {
			get: (instances, prop) => {
				if (!Number.isNaN(Number(prop)))
					return instances[prop];

				let { group_name } = instances;
				
				if (prop === 'add') 
					return (instance) => {
						return this.add_instance_to_group(group_name, instance);
					};
				
				if (prop === 'add_by_name') 
					return this.add_instance_to_group_by_name.bind(this, group_name);

				if (prop === 'remove')
					return (instance) => {
						return this.remove_instance_from_group(group_name, instance);
					};
			
				if (prop === 'remove_by_name') 
					return this.remove_instance_from_group_by_name.bind(this, group_name);
				
				if (prop === 'remove_at') 					
					return (instance_index) => {
						return this.remove_instance_from_group(group_name, instances[instance_index]);
					};

				if (prop === 'length')
					return instances.length;
				
				return void(0);
			}
		};

		let groupsHandler = {
			get: (group_names, prop) => {
				let instances_in_group = [];

				if (group_names.has(prop)) {
					instances_in_group = this.instances.filter((instance) => instance.instance_group.indexOf(prop) !== -1);
				}

				instances_in_group = _.sortBy(instances_in_group, 'instance_name');

				instances_in_group.group_name = prop;

				return new Proxy(instances_in_group, groupHandler);
			}
		};

		return new Proxy(this.group_names, groupsHandler);
	}

	get default_tor_config() {
		if (typeof(this._default_tor_config) === 'function')
			return this._default_tor_config();
		else if (this._default_tor_config)
			return _.cloneDeep(this._default_tor_config);
		else
			return {};
	}

	set default_tor_config(value) { this._default_tor_config = value; }

	static get load_balance_methods() {
		return {
			round_robin: function (instances) {
				return instances.rotate(1);
			},
			weighted: function (instances) {
				if (!instances._weighted_list) {
					instances._weighted_list = new WeightedList(
						instances.map((instance) => {
							return [ instance.id, instance.definition.Weight, instance ]
						})
					);
				};
				let i = instances._weighted_list.peek(instances.length).map((element) => element.data);
				i._weighted_list = instances._weighted_list;
				return i;
			}
		};
	}

	get instances() { 
		return this._instances.slice(0);
	}

	get instance_names() {
		return this.instances.map((i) => i.instance_name);
	}

	async create_instance(instance_definition) {
		if (!(fs.existsSync(this.data_directory)))
			await fs.mkdirAsync(this.data_directory);

		if (instance_definition.Name && this.instance_names.indexOf(instance_definition.Name) !== -1) 
			throw new Error(`Instance named ${instance_definition.Name} already exists`);
		
		this._instances._weighted_list = void(0);
		instance_definition.Config = _.extend(_.cloneDeep(this.default_tor_config), (instance_definition.Config || {}));
		let instance_id = nanoid();
		instance_definition.Config.DataDirectory = instance_definition.Config.DataDirectory || path.join(this.data_directory, (instance_definition.Name || instance_id));
		
		let instance = new TorProcess(this.tor_path, instance_definition, this.granax_options, this.logger);
		
		instance.id = instance_id;
		
		await instance.create();
		
		this._instances.push(instance);

		return await new Promise((resolve, reject) => {
			instance.once('error', reject);

			instance.once('ready', () => {
				this.emit('instance_created', instance);
				resolve(instance);
			});
		});
	}

	async add(instance_definitions) {
		return await Promise.all([].concat(instance_definitions).map((instance_definition) => this.create_instance(instance_definition)));
	}

	async create(instances) {
		if (typeof(instances) === 'number') {
			instances = Array.from(Array(instances)).map(() => {
				return {
					Config: {}
				};
			});
		}
		return await this.add(instances);
	}

	instance_by_name(name) {
		return this._instances.filter((i) => i.instance_name === name)[0];
	}

	instance_at(index) {
		return this._instances[index];
	}

	async remove(instances) {
		this._instances._weighted_list = void(0);
		let instances_to_remove = this._instances.splice(0, instances);
		await Promise.all(instances_to_remove.map((instance) => instance.exit()));
	}

	async remove_at(instance_index) {
		this._instances._weighted_list = void(0);

		let instance = this._instances.splice(instance_index, 1)[0];
		await instance.exit();
	}

	async remove_by_name(instance_name) {
		let instance = this.instance_by_name(instance_name);
		if (!instance) 
			throw new Error(`Instance "${name}" not found`);
		let instance_index = (this.instances.indexOf(instance));
		await this.remove_at(instance_index);
	}

	next() {
		this._instances = TorPool.load_balance_methods[this.load_balance_method](this._instances);
		return this.instances[0];
	}

	async exit() {
		await Promise.all(this._instances.map((instance) => instance.exit()));
		this._instances = [];
	}

	async new_identites() {
		await Promise.all(this.instances.map((instance) => instance.new_identity()));
	}

	async new_identity_at(index) {
		await this.instances[index].new_identity();
	}

	async new_identity_by_name(name) {
		let instance = this.instance_by_name(name);
		
		if (!instance) 
			throw new Error(`Instance "${name}" not found`);
		
		await instance.new_identity();
	}


	async get_config_by_name(name, keyword) {
		let instance = this.instance_by_name(name);
		if (!instance) 
			throw new Error(`Instance "${name}" not found`);
		
		return await instance.get_config(keyword);
	}

	async set_config_by_name(name, keyword, value) {
		let instance = this.instance_by_name(name);
		if (!instance) 
			throw new Error(`Instance "${name}" not found`);
		
		return await instance.set_config(keyword, value);
	}

	async get_config_at(index, keyword) {
		let instance = this.instances[index];
		if (!instance) 
			throw new Error(`Instance at ${index} not found`);
		
		return await instance.get_config(keyword);
	}

	async set_config_at(index, keyword, value) {
		let instance = this.instances[index];
		if (!instance) 
			throw new Error(`Instance at ${index} not found`);
		return await instance.set_config(keyword, value);
	}

	async set_config_all(keyword, value) {
		return await Promise.all(this.instances.map((instance) => instance.set_config(keyword, value)));
	}

	async signal_all(signal) {
		await Promise.all(this.instances.map((instance) => instance.signal(signal)));
	}

	async signal_by_name(name, signal) {
		let instance = this.instance_by_name(name);
		if (!instance) 
			throw new Error(`Instance "${name}" not found`);

		await instance.signal(signal);
	}

	async signal_at(index, signal) {
		let instance = this.instances[index];
		if (!instance) 
			throw new Error(`Instance at ${index} not found`);
		
		await instance.signal(signal);
	}
};

module.exports = TorPool;