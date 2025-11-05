import fs from 'fs/promises';
import path from 'path';
import nock from 'nock';
import request from 'supertest';
import { setupTestApp } from './utils/testServer.js';

describe('Speaker volume settings persistence', () => {
  let app;
  let cleanup;
  let tempDir;

  beforeAll(() => {
    nock.disableNetConnect();
    nock.enableNetConnect('127.0.0.1');
  });

  afterAll(() => {
    nock.enableNetConnect();
  });

  beforeEach(async () => {
    nock.cleanAll();
    ({ app, cleanup, tempDir } = await setupTestApp());
  });

  afterEach(async () => {
    nock.cleanAll();
    await cleanup();
  });

  test('stores and retrieves per-player default volumes', async () => {
    const payload = { RINCON_A: 10, RINCON_B: 80 };

    const putResponse = await request(app).put('/api/settings/volumes').send(payload);
    expect(putResponse.status).toBe(200);
    expect(putResponse.body).toEqual({ RINCON_A: 10, RINCON_B: 80 });

    const fileContents = await fs.readFile(
      path.join(tempDir, '.speaker-volumes.json'),
      'utf8'
    );
    expect(JSON.parse(fileContents)).toEqual({ RINCON_A: 10, RINCON_B: 80 });

    const getResponse = await request(app).get('/api/settings/volumes');
    expect(getResponse.status).toBe(200);
    expect(getResponse.body).toEqual({ RINCON_A: 10, RINCON_B: 80 });
  });

  test('sanitizes out-of-range or invalid volumes', async () => {
    const putResponse = await request(app)
      .put('/api/settings/volumes')
      .send({ RINCON_A: -5, RINCON_B: 999, RINCON_C: 'not-a-number' });

    expect(putResponse.status).toBe(200);
    expect(putResponse.body).toEqual({ RINCON_A: 0, RINCON_B: 100 });

    const fileContents = await fs.readFile(
      path.join(tempDir, '.speaker-volumes.json'),
      'utf8'
    );
    expect(JSON.parse(fileContents)).toEqual({ RINCON_A: 0, RINCON_B: 100 });
  });
});

