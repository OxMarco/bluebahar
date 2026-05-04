import 'reflect-metadata';
import 'dotenv/config';
import { DataSource } from 'typeorm';
import { Dataset } from './scraper/entities/dataset.entity';
import { NoticeToMariners } from './scraper/entities/notice-to-mariners.entity';
import { Weather } from './scraper/entities/weather.entity';

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} is required`);
  }
  return value;
}

function requirePort(name: string): number {
  const value = Number(requireEnv(name));
  if (!Number.isInteger(value) || value <= 0 || value > 65535) {
    throw new Error(`${name} must be a valid TCP port`);
  }
  return value;
}

const appDataSource = new DataSource({
  type: 'postgres',
  host: requireEnv('DB_HOST'),
  port: requirePort('DB_PORT'),
  username: requireEnv('DB_USERNAME'),
  password: requireEnv('DB_PASSWORD'),
  database: requireEnv('DB_NAME'),
  entities: [NoticeToMariners, Weather, Dataset],
  migrations: [`${__dirname}/migrations/*{.ts,.js}`],
  synchronize: false,
});

export default appDataSource;
