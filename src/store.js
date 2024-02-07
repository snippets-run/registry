const baseUrl = 'https://store.homebots.io';
const fetchOptions = { mode: 'cors' };
const fetchHeaders = { headers: { 'content-type': 'application/json' } };
const idIsMissingError = new Error('Id is missing');

/**
 * @class Store
 * @description Representation of a store
 */
export class Store {
  /**
   * Creates a JSON store
   * @returns {Promise<string>} new store ID
   */
  static async create() {
    const x = await fetch(new URL('/new', baseUrl), fetchOptions);
    const store = await x.json();
    return store.id;
  }

  /**
   * Get a store by id
   * @param {string} id
   * @returns {Store}
   */
  static get(id) {
    return new Store(id);
  }

  constructor(id) {
    if (!id) {
      throw idIsMissingError;
    }

    this.id = id;
  }

  /**
   * Get a list of all kinds of resources stored
   * @returns {Promise<string[]>} names
   */
  async getResourceNames() {
    const res = await fetch(new URL(`/${this.id}`, baseUrl));

    if (res.ok) {
      return res.json();
    }

    return [];
  }

  /**
   * Get a resource by name
   * @param {string} name
   * @returns {Resource}
   */
  getResource(name) {
    return new Resource(this.id, name);
  }

  /**
   * Remove an entire store
   * @param {string} id
   */
  async remove() {
    const x = await fetch(new URL('/' + this.id, baseUrl), { ...fetchOptions, method: 'DELETE' });
    return x.ok;
  }
}

/**
 * @class Resource
 * @description Representation of a single kind of resource
 */
class Resource {
  constructor(storeId, name) {
    if (!name) {
      throw new Error('Resource name is missing');
    }

    this.name = name;
    this.resourceUrl = new URL(`/${storeId}/${this.name}/`, baseUrl).toString();
  }

  /**
   * List all content for this resource
   */
  async list() {
    const res = await fetch(this.resourceUrl, fetchOptions);

    if (res.ok) {
      return res.json();
    }

    return [];
  }

  /**
   * Get one item by ID
   * @param {string} [id] resource ID
   */
  async get(id = '') {
    if (!id) {
      throw idIsMissingError;
    }

    const url = new URL(id, this.resourceUrl);
    const x = await fetch(url, fetchOptions);

    return x.json();
  }

  /**
   * Remove one item by ID
   * @param {string} [id] resource ID
   */
  async remove(id = '') {
    if (!id) {
      throw idIsMissingError;
    }

    const url = new URL(id, this.resourceUrl);
    const res = await fetch(url, { ...fetchOptions, method: 'DELETE' });

    return res.ok;
  }

  /**
   * Delete all items of this kind
   */
  async removeAll() {
    const url = new URL(this.resourceUrl);
    const res = await fetch(url, { ...fetchOptions, method: 'DELETE' });

    return res.ok;
  }

  /**
   * Create/update one item
   * @param {string} id unique ID of this resource
   * @param {Object} payload resource to add
   */
  async set(id, payload = {}) {
    const url = new URL(id, this.resourceUrl);
    const res = await fetch(url, {
      ...fetchOptions,
      ...fetchHeaders,
      method: 'PUT',
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      return true;
    }

    throw new Error(res.status);
  }
}