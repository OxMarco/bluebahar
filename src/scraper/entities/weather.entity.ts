import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export interface WeatherForecast {
  sea: string;
  wind: string;
  swell: string;
  weather: string;
  situation?: string;
  visibility: string;
}

export interface WeatherQuadrant {
  sea_state: string;
  wind_strength: string;
  wind_direction: string;
}

export interface WeatherRadarImage {
  quadrant_1: WeatherQuadrant;
  quadrant_2: WeatherQuadrant;
  quadrant_3: WeatherQuadrant;
  quadrant_4: WeatherQuadrant;
}

@Entity()
export class Weather {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Forecast id assigned by the Malta Met Office API; used to dedupe re-fetches.
  @Column({ type: 'int', unique: true })
  externalId!: number;

  @Column({ type: 'timestamp' })
  publishTime!: Date;

  @Column({ type: 'timestamp' })
  lastUpdated!: Date;

  @Index()
  @Column({ type: 'date' })
  forecastDate!: string;

  @Column({ type: 'jsonb' })
  forecast!: WeatherForecast;

  @Column({ type: 'jsonb', nullable: true })
  radarImage?: WeatherRadarImage;

  @Column({ type: 'varchar', nullable: true })
  seaTemperature?: string;

  @CreateDateColumn()
  createdAt!: Date;
}
