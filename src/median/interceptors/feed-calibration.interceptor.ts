import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from "@nestjs/common";
import { Observable } from "rxjs";
import { map } from "rxjs/operators";
import { MedianDeltaCalculatorService } from "../median-delta-calculator.service";
import { FeedValueData } from "src/dto/provider-requests.dto";

export interface Response<T> {
  data: T;
}

interface FeedResponse {
  data: FeedValueData[];
}

@Injectable()
export class FeedCalibrationInterceptor<T extends FeedValueData[]> implements NestInterceptor<T, Response<T>> {
  constructor(private readonly medianService: MedianDeltaCalculatorService) {}
  intercept(context: ExecutionContext, next: CallHandler): Observable<Response<T>> {
    const isEnabled = process.env.FEED_CALIBRATION_ENABLED === "true";
    if (!isEnabled) {
      return next.handle();
    }

    return next.handle().pipe(
      map((res: FeedResponse) => {
        if (Array.isArray(res.data)) {
          res.data.forEach(feedValue => {
            feedValue.value = feedValue.value + this.medianService.getCurrentDelta(feedValue.feed.name);
          });
        }
        return { data: res.data as T };
      })
    );
  }
}
