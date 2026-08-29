import FullHeightScrollView from '@/components/layout/full-height-scroll-view';
import LimitedHtml from '@/components/presentation/foundation/limited-html';
import { Backend, BackendFeature, backendFeatures, backendSupportsFeature, builtInBackendId } from '@/models/backend';
import { useAppSelector } from '@/store';
import { T, useTranslate } from '@tolgee/react';
import { Stack, useRouter } from 'expo-router';
import { Linking, View } from 'react-native';
import { List } from 'react-native-paper';
import { BackendPicker } from '@/components/smart/backend-picker';
import ConfirmationDialog from '@/components/presentation/foundation/confirmation-dialog';
import Form from '@/components/presentation/foundation/form';
import { selectAllBackends, switchFeedBackend } from '@/store/backends';
import { useState } from 'react';
import { useDispatch } from 'react-redux';
import AddIcon from '@expo/material-symbols/add.xml';
import { FormRow } from '@/components/presentation/foundation/form-row';
import { SegmentedList, SegmentListFormElement } from '@/components/presentation/foundation/segmented-list';
import { PageActions } from '@/components/presentation/foundation/page-actions';
import { SurfaceText } from '@/components/presentation/foundation/surface-text';
import Icon from '@/components/presentation/foundation/icon';
import { spacing } from '@/hooks/useAppTheme';

const featureNameKey: Record<
  BackendFeature,
  'backends.feature.feed' | 'backends.feature.ai_planner' | 'backends.feature.backup'
> = {
  feed: 'backends.feature.feed',
  aiPlanner: 'backends.feature.ai_planner',
  backup: 'backends.feature.backup',
};

const docsUrl = 'https://github.com/LiamMorrow/LiftLog/blob/main/docs/SelfHosting.md';

export default function BackendsPage() {
  const { t } = useTranslate();
  const { push } = useRouter();
  const dispatch = useDispatch();
  const backends = useAppSelector(selectAllBackends);
  const [pendingFeedBackend, setPendingFeedBackend] = useState<string | undefined>(undefined);

  const describe = (backend: Backend) =>
    t('backends.supports.subtitle', {
      features: backendFeatures
        .filter((feature) => backendSupportsFeature(backend, feature))
        .map((feature) => t(featureNameKey[feature]))
        .join(', '),
    });

  return (
    <FullHeightScrollView
      floatingChildren={
        <PageActions
          primary={{
            label: t('backends.add.button'),
            onPress: () => push('/settings/backends/new'),
            icon: AddIcon,
            systemImage: 'plus',
          }}
        />
      }
    >
      <Stack.Screen options={{ title: t('backends.title') }} />
      <View style={{ marginHorizontal: spacing.pageHorizontalMargin, marginBottom: spacing[4] }}>
        <SurfaceText color="onSurfaceVariant" font="text-sm">
          <LimitedHtml value={t('backends.explanation')} />
        </SurfaceText>
      </View>
      <Form>
        <FormRow>
          <SegmentedList
            renderItem={(x) => x}
            items={[
              <SegmentListFormElement
                key={0}
                label={t('backends.feed.label')}
                icon={'forum'}
                right={<BackendPicker feature="feed" onChange={setPendingFeedBackend} />}
              />,
              <SegmentListFormElement
                key={1}
                label={t('backends.ai_planner.label')}
                icon={'boltFill'}
                right={<BackendPicker feature="aiPlanner" />}
              />,
              <SegmentListFormElement
                key={2}
                label={t('backends.backup.label')}
                icon={'cloudUploadFill'}
                right={<BackendPicker feature="backup" />}
              />,
            ]}
          />
        </FormRow>
        <FormRow>
          <SegmentedList
            renderItem={(x) => x}
            items={backends.map((backend) => (
              <List.Item
                key={backend.id}
                title={backend.name}
                description={describe(backend)}
                left={(props) => <List.Icon icon={backend.id === builtInBackendId ? 'public' : 'dns'} {...props} />}
                onPress={backend.id === builtInBackendId ? undefined : () => push(`/settings/backends/${backend.id}`)}
              />
            ))}
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
                onPress={() => void Linking.openURL(docsUrl)}
                right={<Icon source="openInBrowser" size={20} />}
              />,
            ]}
          />
        </FormRow>
      </Form>

      <ConfirmationDialog
        open={pendingFeedBackend !== undefined}
        headline={t('backends.feed_switch.title')}
        textContent={<T keyName="backends.feed_switch.message" />}
        onCancel={() => setPendingFeedBackend(undefined)}
        onOk={() => {
          if (pendingFeedBackend) {
            dispatch(switchFeedBackend({ backendId: pendingFeedBackend }));
          }
          setPendingFeedBackend(undefined);
        }}
      />
    </FullHeightScrollView>
  );
}
