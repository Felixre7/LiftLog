import { StatisticOverTime } from '@/store/stats';
import { QuantityAxis } from '@/components/presentation/stats/quantity-axis';
import { LineChart, lineDataItem } from 'react-native-gifted-charts';
import { View } from 'react-native';
import { spacing, useAppTheme } from '@/hooks/useAppTheme';
import { useEffect, useRef, useState } from 'react';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import { lineGraphProps } from '@/components/presentation/stats/line-graph-props';
import { useFormatDate } from '@/hooks/useFormatDate';
import { Text } from 'react-native-paper';

export function StatisticLineChart<T>({
  statistics: { statistics, maxValue, minValue },
  axis,
  pinchZoomEnabled = false,
}: {
  statistics: StatisticOverTime<T>;
  axis: QuantityAxis<T>;
  pinchZoomEnabled?: boolean;
}) {
  const formatDate = useFormatDate();
  const { colors } = useAppTheme();
  const max = axis.toNumber(maxValue);
  const min = axis.toNumber(minValue);
  const points: lineDataItem[] = statistics.map((stat): lineDataItem => {
    const value = axis.toNumber(stat.value);
    const label = formatDate(stat.dateTime.toLocalDate(), {
      day: 'numeric',
      month: 'short',
    });
    return {
      value,
      label,
      focusedDataPointLabelComponent: () => (
        <FocusedDatapointLabelComponent value={axis.formatNumber(value)} label={label} />
      ),
    };
  });
  const [width, setWidth] = useState(0);
  const graphProps = lineGraphProps(colors, width, points.length);
  const maximumSpacing = graphProps.spacing!;
  // Include the chart's 20px padding at each end when fitting the whole series.
  const minimumSpacing = Math.min(maximumSpacing, Math.max(1, width - 70) / Math.max(1, points.length - 1));
  const [zoom, setZoom] = useState(1);
  const pinchStartZoom = useRef(1);
  const minimumZoom = minimumSpacing / maximumSpacing;
  const currentZoom = Math.max(minimumZoom, zoom);
  const pinch = Gesture.Pinch()
    .enabled(pinchZoomEnabled && points.length > 1)
    .runOnJS(true)
    .onStart(() => {
      pinchStartZoom.current = currentZoom;
    })
    .onUpdate((event) => {
      setZoom(Math.min(1, Math.max(minimumZoom, pinchStartZoom.current * event.scale)));
    });
  const pointSpacing = maximumSpacing * currentZoom;
  const labelInterval = Math.max(1, Math.ceil(50 / pointSpacing));
  // On android the area chart renders poorly unless it is delayed until after initial render
  const [areaChart, setAreaChart] = useState(false);
  useEffect(() => {
    setAreaChart(!!width);
  }, [width]);
  return (
    <GestureDetector gesture={pinch}>
      <View collapsable={false} onLayout={(e) => setWidth(e.nativeEvent.layout.width)}>
        <LineChart
          {...graphProps}
          spacing={pinchZoomEnabled ? pointSpacing : maximumSpacing}
          negativeStepValue={min < 0 ? -0.2 * min : undefined!}
          showFractionalValues={false}
          dataPointLabelWidth={70}
          showReferenceLine1
          areaChart={areaChart}
          delayBeforeUnFocus={10_000}
          referenceLine1Position={max}
          dataSet={[
            {
              data: points.map((point, index) => ({
                ...point,
                label: index % labelInterval === 0 ? point.label : undefined,
              })),
              strokeDashArray: [1],
              dataPointsColor: colors.primary,
              color: colors.primary,
              dataPointsRadius: 5,
              startFillColor: colors.primary,
              endFillColor: colors.primary,
              startOpacity: 0.1,
              endOpacity: 0.1,
            },
          ]}
          showDataPointLabelOnFocus
          noOfSections={4}
          height={100}
          mostNegativeValue={min < 0 ? min : undefined!}
          yAxisOffset={Math.floor(min) - 10}
          noOfSectionsBelowXAxis={min < 0 ? 5 : 0}
        />
      </View>
    </GestureDetector>
  );
}

function FocusedDatapointLabelComponent(props: { value: string; label: string }) {
  const { colors } = useAppTheme();
  return (
    <View
      style={{
        alignItems: 'center',
        paddingVertical: spacing[1],
        backgroundColor: colors.surface,
        borderRadius: 4,
        borderColor: colors.outline,
        borderStyle: 'solid',
        borderWidth: 1,
      }}
    >
      <Text>{props.label}</Text>
      <Text>{props.value}</Text>
    </View>
  );
}
