import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { AdminService } from './admin.service';
import { AdminApiKeyGuard } from './admin-api-key.guard';
import { ViewLogsDto } from './dto/view-logs.dto';
import { ViewFlaggedDto } from './dto/view-flagged.dto';
import { CreateNoticeDto } from './dto/create-notice.dto';
import { GetNoticesDto } from '../map/dto/get-notices.dto';

@Controller({
  path: '/admin',
  version: '1',
})
@UseGuards(AdminApiKeyGuard)
export class AdminController {
  constructor(private readonly adminService: AdminService) {}

  @Get('logs')
  viewLogs(@Query() query: ViewLogsDto) {
    return this.adminService.viewLogs(query);
  }

  @Get('notices/flagged')
  viewFlaggedNotices(@Query() query: ViewFlaggedDto) {
    return this.adminService.viewFlaggedNotices(query);
  }

  @Get('notices/review')
  viewNoticesInReview(@Query() query: GetNoticesDto) {
    return this.adminService.viewNoticesInReview(query);
  }

  @Post('notices')
  addNtm(@Body() dto: CreateNoticeDto) {
    return this.adminService.addNtm(dto);
  }

  @Post('notices/:id/approve')
  approveNtM(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.approveNtM(id);
  }

  @Post('notices/:id/dismiss-reports')
  dismissReports(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.dismissReports(id);
  }

  @Delete('notices/:id')
  rejectNtM(@Param('id', ParseUUIDPipe) id: string) {
    return this.adminService.rejectNtM(id);
  }
}
