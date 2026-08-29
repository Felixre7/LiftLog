import { Switch } from '@/components/presentation/foundation/switch';
import { AppIconSource } from '@/components/presentation/foundation/ms-icon-source';
import { SegmentListFormElement } from '@/components/presentation/foundation/segmented-list';
import { spacing, useAppTheme } from '@/hooks/useAppTheme';
import { Text } from 'react-native-paper';

interface ListSwitchProps {
  label: string;
  supportingText?: string;
  icon: AppIconSource;
  value: boolean;
  onValueChange: (value: boolean) => void;
  testID?: string;
  disabled?: boolean;
}

export function SegmentedListSwitch(props: ListSwitchProps) {
  const { colors } = useAppTheme();
  return (
    <SegmentListFormElement
      label={props.label}
      icon={props.icon}
      onPress={() => props.onValueChange(!props.value)}
      right={
        <Switch
          value={props.value}
          disabled={props.disabled}
          testID={props.testID}
          onValueChange={props.onValueChange}
        />
      }
      line2={
        props.supportingText ? (
          <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant, marginBlockStart: spacing[2] }}>
            {props.supportingText}
          </Text>
        ) : undefined
      }
    />
  );
}
