import FullHeightScrollView from '@/components/layout/full-height-scroll-view';
import { BackendHeaderEditor } from '@/components/presentation/backends/backend-header-editor';
import ConfirmationDialog from '@/components/presentation/foundation/confirmation-dialog';
import Form from '@/components/presentation/foundation/form';
import LabelledFormRow from '@/components/presentation/foundation/labelled-form-row';
import { PageActions } from '@/components/presentation/foundation/page-actions';
import SelectPicker from '@/components/presentation/foundation/select-picker';
import { FormRow } from '@/components/presentation/foundation/form-row';
import { SegmentedList, SegmentListFormElement } from '@/components/presentation/foundation/segmented-list';
import { spacing, useAppTheme } from '@/hooks/useAppTheme';
import { Backend, BackendHeader, BackendKind, normalizeBackendUrl } from '@/models/backend';
import { BackendProbeResult, probeBackendFeatures, probeBackupEndpoint } from '@/services/backend-probe';
import { useAppSelector } from '@/store';
import { putBackend, removeBackend } from '@/store/backends';
import { uuid } from '@/utils/uuid';
import { T, TranslationKey, useTranslate } from '@tolgee/react';
import { Stack, useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import SaveIcon from '@expo/material-symbols/save.xml';
import ExperimentIcon from '@expo/material-symbols/experiment.xml';
import DeleteIcon from '@expo/material-symbols/delete.xml';
import { HelperText, Text, TextInput } from 'react-native-paper';
import { useDispatch } from 'react-redux';

const kindOptions = [
  { value: 'liftlog', label: 'backends.kind.liftlog.label', body: 'backends.kind.liftlog.body' },
  {
    value: 'backupEndpoint',
    label: 'backends.kind.backup_endpoint.label',
    body: 'backends.kind.backup_endpoint.body',
  },
] as const satisfies { value: BackendKind; label: TranslationKey; body: TranslationKey }[];

type ProbeState = { status: 'idle' } | { status: 'checking' } | { status: 'done'; message: string; ok: boolean };

export default function BackendEditorPage() {
  const { t } = useTranslate();
  const { colors } = useAppTheme();
  const dispatch = useDispatch();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const existing = useAppSelector((s) => s.backends.backends.find((x) => x.id === id));

  const [name, setName] = useState(existing?.name ?? '');
  const [url, setUrl] = useState(existing?.url ?? '');
  const [kind, setKind] = useState<BackendKind>(existing?.kind ?? 'liftlog');
  const [headers, setHeaders] = useState<BackendHeader[]>(existing?.headers ?? []);
  const [probe, setProbe] = useState<ProbeState>({ status: 'idle' });
  const [deleteOpen, setDeleteOpen] = useState(false);

  const urlError = url && !/^https?:\/\//.test(url.trim()) ? 'URL must start with http:// or https://' : '';
  const canSave = !!name.trim() && !!url.trim() && !urlError;

  const buildBackend = (): Backend => ({
    id: existing?.id ?? uuid(),
    name: name.trim(),
    url: normalizeBackendUrl(url),
    kind,
    headers,
  });

  const describeProbe = (result: BackendProbeResult) =>
    result.status === 'ok'
      ? t('backends.test.offers', { features: result.features.join(', ') })
      : result.status === 'notLiftLog'
        ? t('backends.test.not_liftlog')
        : t('backends.test.unreachable');

  const test = async () => {
    const backend = buildBackend();
    setProbe({ status: 'checking' });
    // A backup endpoint has no /features to ask, so it is checked the only way the protocol allows.
    if (backend.kind === 'backupEndpoint') {
      const result = await probeBackupEndpoint(backend);
      setProbe({
        status: 'done',
        ok: result.status === 'ok',
        message:
          result.status === 'ok'
            ? t('backends.test.backup_ok')
            : result.status === 'refused'
              ? t('backends.test.backup_refused', { status: result.statusCode })
              : t('backends.test.unreachable'),
      });
      return;
    }
    const result = await probeBackendFeatures(backend);
    setProbe({ status: 'done', message: describeProbe(result), ok: result.status === 'ok' });
  };

  // A LiftLog backend that cannot answer is saved as nothing anyone could use, so it is not saved at
  // all. Probed here rather than trusting an earlier Test, which the URL or headers may have moved on
  // from since.
  const save = async () => {
    const backend = buildBackend();
    if (backend.kind === 'liftlog') {
      setProbe({ status: 'checking' });
      const result = await probeBackendFeatures(backend);
      if (result.status !== 'ok') {
        setProbe({ status: 'done', message: `${t('backends.save.blocked')} - ${describeProbe(result)}`, ok: false });
        return;
      }
    }
    dispatch(putBackend(backend));
    router.back();
  };

  return (
    <FullHeightScrollView
      floatingChildren={
        <PageActions
          primaryKind={'commit'}
          primary={{
            disabled: !canSave || probe.status === 'checking',
            label: t('generic.save.button'),
            onPress: () => void save(),
            icon: SaveIcon,
            systemImage: 'checkmark.app',
          }}
          secondary={[
            {
              disabled: !canSave || probe.status === 'checking',
              label: t('generic.test.button'),
              onPress: () => void test(),
              icon: ExperimentIcon,
              systemImage: 'flask',
            },
            ...(existing
              ? [
                  {
                    label: t('generic.delete.button'),
                    onPress: () => setDeleteOpen(true),
                    icon: DeleteIcon,
                    systemImage: 'trash',
                  } as const,
                ]
              : []),
          ]}
        />
      }
    >
      <Stack.Screen options={{ title: existing?.name || t('backends.add.button') }} />
      <Form>
        <LabelledFormRow label={t('backends.name.label')} icon="dnsFill">
          <TextInput mode="outlined" value={name} onChangeText={setName} autoCorrect={false} />
        </LabelledFormRow>
        <LabelledFormRow label={t('backends.url.label')} icon="publicFill">
          <TextInput
            mode="outlined"
            placeholder="https://liftlog.example.com"
            value={url}
            error={!!urlError}
            onChangeText={setUrl}
            autoCorrect={false}
            autoCapitalize="none"
            keyboardType="url"
          />
          <HelperText type="error">{urlError}</HelperText>
        </LabelledFormRow>
        <FormRow>
          <SegmentedList
            renderItem={(x) => x}
            items={[
              <SegmentListFormElement
                key={0}
                label={t('backends.kind.label')}
                icon={'settingsFill'}
                right={
                  <SelectPicker
                    value={kind}
                    options={kindOptions.map(({ value, label }) => ({ value, label: t(label) }))}
                    onChange={setKind}
                  />
                }
                line2={
                  <Text variant="bodySmall" style={{ color: colors.onSurfaceVariant, marginBlockStart: spacing[2] }}>
                    {t(kindOptions.find((option) => option.value === kind)!.body)}
                  </Text>
                }
              />,
            ]}
          />
        </FormRow>
        <FormRow>
          <BackendHeaderEditor headers={headers} onChange={setHeaders} />
        </FormRow>
      </Form>

      {probe.status === 'idle' ? null : (
        <HelperText
          type={probe.status === 'done' && !probe.ok ? 'error' : 'info'}
          style={{ marginHorizontal: spacing[6] }}
        >
          {probe.status === 'checking' ? t('backends.test.checking') : probe.message}
        </HelperText>
      )}

      <ConfirmationDialog
        open={deleteOpen}
        headline={t('backends.delete.title')}
        textContent={<T keyName="backends.delete.message" />}
        onCancel={() => setDeleteOpen(false)}
        onOk={() => {
          if (existing) {
            dispatch(removeBackend(existing.id));
          }
          router.back();
        }}
      />
    </FullHeightScrollView>
  );
}
