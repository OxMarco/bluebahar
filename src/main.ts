import { NestFactory, Reflector } from '@nestjs/core';
import {
  ValidationPipe,
  HttpStatus,
  ValidationError,
  UnprocessableEntityException,
  ClassSerializerInterceptor,
  Logger,
  VersioningType,
} from '@nestjs/common';
import { NestExpressApplication } from '@nestjs/platform-express';
import { SwaggerModule, DocumentBuilder } from '@nestjs/swagger';
import helmet from 'helmet';
import { TypeOrmNotFoundExceptionFilter } from './common/filters/entity-not-found.filter';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    cors: true,
    bufferLogs: false,
  });
  const config = new DocumentBuilder()
    .setTitle('Docs')
    .setDescription('Backend API description')
    .setVersion('1.0')
    .build();
  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, documentFactory);

  const reflector = app.get(Reflector);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidUnknownValues: true,
      errorHttpStatusCode: HttpStatus.UNPROCESSABLE_ENTITY,
      transform: true,
      dismissDefaultMessages: true,
      exceptionFactory: (errors: ValidationError[]) => {
        const messages = errors.flatMap((error) =>
          Object.values(error.constraints ?? {}),
        );
        return new UnprocessableEntityException(messages);
      },
    }),
  );
  app.useGlobalInterceptors(new ClassSerializerInterceptor(reflector));
  app.useGlobalFilters(new TypeOrmNotFoundExceptionFilter());
  app.use(helmet());
  app.enableShutdownHooks();
  app.enableVersioning({ type: VersioningType.URI, defaultVersion: '1' });
  app.enable('trust proxy');

  await app.listen(process.env.PORT ?? 3000);
}

bootstrap().catch((err) => {
  Logger.error(err, 'Bootstrap');
  process.exit(1);
});
