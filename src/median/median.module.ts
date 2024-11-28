import { forwardRef, Module } from "@nestjs/common";
import { MedianDeltaCalculatorService } from "./median-delta-calculator.service";
import { APP_INTERCEPTOR } from "@nestjs/core";
import { FeedCalibrationInterceptor } from "./interceptors/feed-calibration.interceptor";
import { RandomExampleProviderModule } from "src/app.module";

@Module({
  imports: [forwardRef(() => RandomExampleProviderModule)],
  providers: [MedianDeltaCalculatorService, { provide: APP_INTERCEPTOR, useClass: FeedCalibrationInterceptor }],
  exports: [MedianDeltaCalculatorService],
})
export class MedianModule {}
