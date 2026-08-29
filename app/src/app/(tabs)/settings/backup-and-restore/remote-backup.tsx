import FullHeightScrollView from '@/components/layout/full-height-scroll-view';
import Form from '@/components/presentation/foundation/form';
import LimitedHtml from '@/components/presentation/foundation/limited-html';
import { spacing } from '@/hooks/useAppTheme';
import { useAppSelector } from '@/store';
import { executeRemoteBackup, setBackupIncludeFeedAccount } from '@/store/settings';
import { useTranslate } from '@tolgee/react';
import { Stack, useRouter } from 'expo-router';
import { Linking, View } from 'react-native';
import { useDispatch } from 'react-redux';
import { FormRow } from '@/components/presentation/foundation/form-row';
import { SegmentedList, SegmentListFormElement } from '@/components/presentation/foundation/segmented-list';
import { SegmentedListSwitch } from '@/components/presentation/foundation/segmented-list-switch';
import { SurfaceText } from '@/components/presentation/foundation/surface-text';
import Icon from '@/components/presentation/foundation/icon';
import ExperimentIcon from '@expo/material-symbols/experiment.xml';
import { PageActions } from '@/components/presentation/foundation/page-actions';
import { BackendPicker } from '@/components/smart/backend-picker';
import DnsIcon from '@expo/material-symbols/dns.xml';

const docsUrl = 'https://github.com/LiamMorrow/LiftLog/blob/main/docs/RemoteBackup.md';

export default function RemoteBackupPage() {
  const { t } = useTranslate();
  const dispatch = useDispatch();
  const router = useRouter();
  const includeFeedAccount = useAppSelector((s) => s.settings.backupIncludeFeedAccount);
  const assignedBackend = useAppSelector((s) => s.backends.assignments.backup);
  const openUrl = (url: string) => {
    void Linking.canOpenURL(url).then(() => Linking.openURL(url));
  };

  return (
    <FullHeightScrollView
      avoidKeyboard
      floatingChildren={
        <PageActions
          primary={{
            label: t('generic.test.button'),
            onPress: () => dispatch(executeRemoteBackup({ force: true })),
            icon: ExperimentIcon,
            systemImage: 'flask',
            disabled: !assignedBackend,
          }}
          secondary={[
            {
              label: t('backends.manage.button'),
              onPress: () => router.push('/settings/backends'),
              icon: DnsIcon,
              systemImage: 'server.rack',
            },
          ]}
        />
      }
    >
      <Stack.Screen options={{ title: t('backup.automatic_remote.title') }} />
      <View style={{ marginHorizontal: spacing.pageHorizontalMargin, marginBottom: spacing[4] }}>
        <SurfaceText color="onSurfaceVariant" font="text-sm">
          <LimitedHtml value={t('backup.remote.explanation')} />
        </SurfaceText>
      </View>
      <Form>
        <FormRow>
          <SegmentedList
            renderItem={(x) => x}
            items={[
              <SegmentListFormElement
                key={0}
                label={t('backends.backup.label')}
                icon={'cloudUploadFill'}
                right={<BackendPicker feature="backup" />}
              />,
              <SegmentedListSwitch
                key={1}
                label={t('feed.backup_account.title')}
                supportingText={t('feed.backup_account.subtitle')}
                icon={'vpnKeyFill'}
                value={includeFeedAccount}
                onValueChange={(value) => dispatch(setBackupIncludeFeedAccount(value))}
              />,
            ]}
          />
        </FormRow>
        <FormRow>
          <SegmentedList
            renderItem={(x) => x}
            items={[
              <SegmentListFormElement
                key={0}
                label={t('generic.read_documentation.button')}
                icon={'description'}
                onPress={() => openUrl(docsUrl)}
                right={<Icon source="openInBrowser" size={20} />}
              />,
            ]}
          />
        </FormRow>
      </Form>
    </FullHeightScrollView>
  );
}
