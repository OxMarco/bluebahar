import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpStatus,
} from '@nestjs/common';
import { Response } from 'express';
import { EntityNotFoundError } from 'typeorm';

@Catch(EntityNotFoundError)
export class TypeOrmNotFoundExceptionFilter implements ExceptionFilter {
  catch(exception: EntityNotFoundError, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();

    // Extract entity name from the error message
    // TypeORM error message format: "Could not find any entity of type "EntityName" matching: ..."
    const errorMessage = exception.message;
    const matches = errorMessage.match(/entity of type "([^"]+)"/);
    const entityName = matches ? matches[1] : 'Entity';

    response.status(HttpStatus.NOT_FOUND).json({
      error: `${entityName} not found`,
      statusCode: HttpStatus.NOT_FOUND,
    });
  }
}
