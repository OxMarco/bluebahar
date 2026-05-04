import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1777893723203 implements MigrationInterface {
  name = 'InitialSchema1777893723203';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
    await queryRunner.query(
      `CREATE TYPE "public"."notice_to_mariners_kind_enum" AS ENUM('area', 'facility', 'advisory')`,
    );
    await queryRunner.query(`
      CREATE TABLE "notice_to_mariners" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "kind" "public"."notice_to_mariners_kind_enum" NOT NULL,
        "title" character varying NOT NULL,
        "description" character varying NOT NULL,
        "source" character varying NOT NULL,
        "locationLabel" character varying,
        "area" jsonb NOT NULL DEFAULT '[]',
        "publishedAt" TIMESTAMP NOT NULL,
        "activeFrom" TIMESTAMP NOT NULL,
        "activeTo" TIMESTAMP,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_766cc99f0d0eea8535c28f687a4" UNIQUE ("source"),
        CONSTRAINT "PK_cdf6fc27b78fbef5d34632cfe0d" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_5d69dee435138cc57a0b33291b" ON "notice_to_mariners" ("kind")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3573965522dc2a3c05ad34a145" ON "notice_to_mariners" ("activeFrom")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_3f7945fdbac45d9cf6a5eedd59" ON "notice_to_mariners" ("activeTo")`,
    );

    await queryRunner.query(`
      CREATE TABLE "weather" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "externalId" integer NOT NULL,
        "publishTime" TIMESTAMP NOT NULL,
        "lastUpdated" TIMESTAMP NOT NULL,
        "forecastDate" date NOT NULL,
        "forecast" jsonb NOT NULL,
        "radarImage" jsonb,
        "seaTemperature" character varying,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_c3bfb477ae8c03ea5ae15a9d737" UNIQUE ("externalId"),
        CONSTRAINT "PK_af9937471586e6798a5e4865f2d" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_f2b100f935916d184bd6bd439b" ON "weather" ("forecastDate")`,
    );

    await queryRunner.query(`
      CREATE TABLE "dataset" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "key" character varying NOT NULL,
        "name" character varying NOT NULL,
        "sourceUrl" character varying NOT NULL,
        "filePath" character varying NOT NULL,
        "sha256" character varying(64) NOT NULL,
        "featureCount" integer NOT NULL,
        "byteSize" integer NOT NULL,
        "fetchedAt" TIMESTAMP NOT NULL,
        "createdAt" TIMESTAMP NOT NULL DEFAULT now(),
        "updatedAt" TIMESTAMP NOT NULL DEFAULT now(),
        CONSTRAINT "UQ_80a8c992b0a3135fbdbcf30761d" UNIQUE ("key"),
        CONSTRAINT "PK_36c1c67adb3d1dd69ae57f18913" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "dataset"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_f2b100f935916d184bd6bd439b"`,
    );
    await queryRunner.query(`DROP TABLE "weather"`);
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3f7945fdbac45d9cf6a5eedd59"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_3573965522dc2a3c05ad34a145"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_5d69dee435138cc57a0b33291b"`,
    );
    await queryRunner.query(`DROP TABLE "notice_to_mariners"`);
    await queryRunner.query(
      `DROP TYPE "public"."notice_to_mariners_kind_enum"`,
    );
  }
}
