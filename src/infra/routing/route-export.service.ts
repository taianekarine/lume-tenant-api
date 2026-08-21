import { Injectable } from '@nestjs/common';
import ExcelJS from 'exceljs';

import { validationError } from '../../core/errors/app-error';
import {
  routeAddressText,
  type RouteAddress,
} from '../../domain/routing/route';
import type { ContractProps } from '../../domain/routing/contract';
import type { RoutingCompanyProps } from '../../domain/routing/routing-company';

interface ExportPoint {
  id: string;
  sequence: number;
  address: RouteAddress;
  scheduledTime: string | null;
  origin: string;
  alerts: string[];
}

interface ExportAssignment {
  passengerId: string;
  passengerName?: string;
  pointId: string | null;
  status: string;
  warnings: string[];
  accessibilityRequired?: boolean;
  accessibilityNotes?: string | null;
}

interface ApprovedRouteSnapshot {
  route: {
    id: string;
    code: string;
    name: string;
    contractId: string;
    shift: string;
    requiredArrivalTime: string;
    type: string;
    predictedVehicleName: string;
    predictedVehicleReference: string | null;
    predictedVehicleCapacity: number;
    plannedOutboundKm: number | null;
    plannedReturnKm: number | null;
    plannedTotalKm: number | null;
    estimatedDurationMinutes: number | null;
    version: number;
    origin: RouteAddress;
    destination: RouteAddress;
    notes: string | null;
  };
  points: ExportPoint[];
  assignments: ExportAssignment[];
  navigationLinks?: Array<{ label: string; url: string }>;
}

export interface RouteExportContext {
  snapshot: Readonly<Record<string, unknown>>;
  contract: ContractProps;
  routingCompany: RoutingCompanyProps;
}

function readSnapshot(
  snapshot: Readonly<Record<string, unknown>>,
): ApprovedRouteSnapshot {
  const value = snapshot as unknown as ApprovedRouteSnapshot;
  if (
    !value.route ||
    !Array.isArray(value.points) ||
    !Array.isArray(value.assignments)
  ) {
    throw validationError('A versao aprovada da rota esta incompleta.');
  }
  return value;
}

function pointPassengers(
  snapshot: ApprovedRouteSnapshot,
  pointId: string,
): ExportAssignment[] {
  return snapshot.assignments.filter(
    (assignment) =>
      assignment.pointId === pointId && assignment.status === 'assigned',
  );
}

function myMapsRows(context: RouteExportContext) {
  const snapshot = readSnapshot(context.snapshot);
  const route = snapshot.route;
  const base = {
    routeName: route.name,
    company:
      context.routingCompany.tradeName ?? context.routingCompany.legalName,
    contract: `${context.contract.code} - ${context.contract.name}`,
    shift: route.shift,
    vehicle: route.predictedVehicleReference
      ? `${route.predictedVehicleName} (${route.predictedVehicleReference})`
      : route.predictedVehicleName,
  };
  const rows = [
    {
      ...base,
      order: 0,
      pointType: 'saida',
      pointName: route.origin.label,
      address: routeAddressText(route.origin),
      latitude: route.origin.latitude,
      longitude: route.origin.longitude,
      passengers: '',
      observations: route.notes ?? '',
    },
  ];
  const points = [...snapshot.points].sort(
    (left, right) => left.sequence - right.sequence,
  );
  for (const point of points) {
    const assignments = pointPassengers(snapshot, point.id);
    rows.push({
      ...base,
      order: point.sequence,
      pointType: 'embarque',
      pointName: point.address.label,
      address: routeAddressText(point.address),
      latitude: point.address.latitude,
      longitude: point.address.longitude,
      passengers: assignments
        .map((assignment) => assignment.passengerName ?? assignment.passengerId)
        .join(' | '),
      observations: [
        ...point.alerts,
        ...assignments.flatMap((assignment) => assignment.warnings),
      ].join(' | '),
    });
  }
  rows.push({
    ...base,
    order: points.length + 1,
    pointType: 'destino',
    pointName: route.destination.label,
    address: routeAddressText(route.destination),
    latitude: route.destination.latitude,
    longitude: route.destination.longitude,
    passengers: '',
    observations: `Chegada prevista: ${route.requiredArrivalTime}`,
  });
  rows.push({
    ...base,
    order: points.length + 2,
    pointType: 'retorno',
    pointName: `Retorno - ${route.origin.label}`,
    address: routeAddressText(route.origin),
    latitude: route.origin.latitude,
    longitude: route.origin.longitude,
    passengers: '',
    observations: 'Ponto final / garagem',
  });
  return rows;
}

const myMapsColumns = [
  ['routeName', 'Nome da rota'],
  ['company', 'Empresa'],
  ['contract', 'Contrato vinculado'],
  ['shift', 'Turno'],
  ['vehicle', 'Veiculo previsto'],
  ['order', 'Ordem do ponto'],
  ['pointType', 'Tipo do ponto'],
  ['pointName', 'Nome do ponto'],
  ['address', 'Endereco completo'],
  ['latitude', 'Latitude'],
  ['longitude', 'Longitude'],
  ['passengers', 'Colaboradores vinculados'],
  ['observations', 'Observacoes'],
] as const;

function styleHeader(row: ExcelJS.Row) {
  row.height = 28;
  row.eachCell((cell) => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FF16324F' },
    };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
  });
}

function configureSheet(sheet: ExcelJS.Worksheet) {
  sheet.views = [{ state: 'frozen', ySplit: 1 }];
  sheet.autoFilter = {
    from: 'A1',
    to: `${sheet.getColumn(sheet.columnCount).letter}1`,
  };
  sheet.eachRow((row, rowNumber) => {
    if (rowNumber === 1) return;
    row.alignment = { vertical: 'top', wrapText: true };
    if (rowNumber % 2 === 0) {
      row.eachCell((cell) => {
        cell.fill = {
          type: 'pattern',
          pattern: 'solid',
          fgColor: { argb: 'FFF2F6FA' },
        };
      });
    }
  });
}

function csvCell(value: unknown): string {
  const text =
    value === null || value === undefined
      ? ''
      : typeof value === 'string' ||
          typeof value === 'number' ||
          typeof value === 'boolean' ||
          typeof value === 'bigint'
        ? String(value)
        : (JSON.stringify(value) ?? '');
  return `"${text.replaceAll('"', '""')}"`;
}

function ascii(value: string): string {
  return value
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, '');
}

function escapePdf(value: string): string {
  return ascii(value)
    .replaceAll('\\', '\\\\')
    .replaceAll('(', '\\(')
    .replaceAll(')', '\\)');
}

function basicPdf(title: string, lines: string[]): Buffer {
  const pages: string[][] = [];
  for (let index = 0; index < lines.length; index += 44) {
    pages.push(lines.slice(index, index + 44));
  }
  if (pages.length === 0) pages.push([]);
  const objects: string[] = [];
  const add = (value: string) => {
    objects.push(value);
    return objects.length;
  };
  const catalogId = add('');
  const pagesId = add('');
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const pageIds: number[] = [];
  for (const [pageIndex, pageLines] of pages.entries()) {
    const content = [
      'BT',
      '/F1 15 Tf',
      '50 790 Td',
      `(${escapePdf(title)}) Tj`,
      '/F1 9 Tf',
      '0 -24 Td',
      ...pageLines.flatMap((line) => [
        `(${escapePdf(line.slice(0, 120))}) Tj`,
        '0 -16 Td',
      ]),
      `(${escapePdf(`Pagina ${pageIndex + 1} de ${pages.length}`)}) Tj`,
      'ET',
    ].join('\n');
    const contentId = add(
      `<< /Length ${Buffer.byteLength(content, 'ascii')} >>\nstream\n${content}\nendstream`,
    );
    const pageId = add(
      `<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`,
    );
    pageIds.push(pageId);
  }
  objects[catalogId - 1] = `<< /Type /Catalog /Pages ${pagesId} 0 R >>`;
  objects[pagesId - 1] =
    `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  let body = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'ascii'));
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(body, 'ascii');
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  body += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('');
  body += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return Buffer.from(body, 'ascii');
}

@Injectable()
export class RouteExportService {
  async myMapsXlsx(context: RouteExportContext): Promise<Buffer> {
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TKS Lume';
    workbook.created = new Date();
    const sheet = workbook.addWorksheet('Google My Maps');
    sheet.columns = myMapsColumns.map(([key, header]) => ({
      key,
      header,
      width:
        key === 'address' || key === 'passengers' || key === 'observations'
          ? 42
          : 20,
    }));
    myMapsRows(context).forEach((row) => sheet.addRow(row));
    styleHeader(sheet.getRow(1));
    configureSheet(sheet);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  myMapsCsv(context: RouteExportContext): Buffer {
    const rows = myMapsRows(context);
    const content = [
      myMapsColumns.map(([, header]) => csvCell(header)).join(','),
      ...rows.map((row) =>
        myMapsColumns.map(([key]) => csvCell(row[key])).join(','),
      ),
    ].join('\r\n');
    return Buffer.from(`\uFEFF${content}`, 'utf8');
  }

  async operationalXlsx(context: RouteExportContext): Promise<Buffer> {
    const snapshot = readSnapshot(context.snapshot);
    const workbook = new ExcelJS.Workbook();
    workbook.creator = 'TKS Lume';
    const summary = workbook.addWorksheet('Resumo aprovado');
    summary.columns = [
      { key: 'field', header: 'Campo', width: 34 },
      { key: 'value', header: 'Valor', width: 70 },
    ];
    const costCenters = context.contract.costCenters
      .map((center) =>
        center.name ? `${center.code} - ${center.name}` : center.code,
      )
      .join(' | ');
    [
      [
        'Empresa',
        context.routingCompany.tradeName ?? context.routingCompany.legalName,
      ],
      ['Contrato', `${context.contract.code} - ${context.contract.name}`],
      ['Centro(s) de custo', costCenters],
      ['Rota', `${snapshot.route.code} - ${snapshot.route.name}`],
      ['Versao aprovada', snapshot.route.version],
      ['Turno', snapshot.route.shift],
      ['Chegada prevista', snapshot.route.requiredArrivalTime],
      ['Veiculo previsto', snapshot.route.predictedVehicleName],
      ['Capacidade', snapshot.route.predictedVehicleCapacity],
      ['KM previsto ida', snapshot.route.plannedOutboundKm ?? 'Nao calculado'],
      ['KM previsto volta', snapshot.route.plannedReturnKm ?? 'Nao calculado'],
      ['KM total previsto', snapshot.route.plannedTotalKm ?? 'Nao calculado'],
      [
        'Duracao estimada (min)',
        snapshot.route.estimatedDurationMinutes ?? 'Nao calculada',
      ],
    ].forEach(([field, value]) => summary.addRow({ field, value }));
    styleHeader(summary.getRow(1));
    configureSheet(summary);

    const sequence = workbook.addWorksheet('Sequencia');
    sequence.columns = [
      { key: 'order', header: 'Ordem', width: 10 },
      { key: 'time', header: 'Horario', width: 12 },
      { key: 'point', header: 'Ponto', width: 28 },
      { key: 'address', header: 'Endereco', width: 48 },
      { key: 'passengers', header: 'Colaboradores', width: 48 },
      { key: 'count', header: 'Quantidade', width: 12 },
      { key: 'origin', header: 'Origem do dado', width: 18 },
      { key: 'alerts', header: 'Alertas / observacoes', width: 48 },
    ];
    [...snapshot.points]
      .sort((left, right) => left.sequence - right.sequence)
      .forEach((point) => {
        const assignments = pointPassengers(snapshot, point.id);
        sequence.addRow({
          order: point.sequence,
          time: point.scheduledTime ?? '',
          point: point.address.label,
          address: routeAddressText(point.address),
          passengers: assignments
            .map(
              (assignment) =>
                assignment.passengerName ?? assignment.passengerId,
            )
            .join('\n'),
          count: assignments.length,
          origin: point.origin,
          alerts: [
            ...point.alerts,
            ...assignments.flatMap((assignment) => assignment.warnings),
          ].join('\n'),
        });
      });
    styleHeader(sequence.getRow(1));
    configureSheet(sequence);

    const links = workbook.addWorksheet('Links Google Maps');
    links.columns = [
      { key: 'label', header: 'Link', width: 24 },
      { key: 'url', header: 'URL', width: 100 },
    ];
    (snapshot.navigationLinks ?? []).forEach((link) => links.addRow(link));
    styleHeader(links.getRow(1));
    configureSheet(links);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  }

  operationalPdf(context: RouteExportContext): Buffer {
    const snapshot = readSnapshot(context.snapshot);
    const lines = [
      `Empresa: ${context.routingCompany.tradeName ?? context.routingCompany.legalName}`,
      `Contrato: ${context.contract.code} - ${context.contract.name}`,
      `Rota: ${snapshot.route.code} - ${snapshot.route.name}`,
      `Versao aprovada: ${snapshot.route.version}`,
      `Turno: ${snapshot.route.shift} | Chegada: ${snapshot.route.requiredArrivalTime}`,
      `Veiculo: ${snapshot.route.predictedVehicleName} | Capacidade: ${snapshot.route.predictedVehicleCapacity}`,
      `KM ida: ${snapshot.route.plannedOutboundKm ?? '-'} | KM volta: ${snapshot.route.plannedReturnKm ?? '-'} | KM total: ${snapshot.route.plannedTotalKm ?? '-'}`,
      '',
      `Saida: ${snapshot.route.origin.label} - ${routeAddressText(snapshot.route.origin)}`,
      ...[...snapshot.points]
        .sort((left, right) => left.sequence - right.sequence)
        .flatMap((point) => {
          const passengers = pointPassengers(snapshot, point.id);
          return [
            `${point.sequence}. ${point.scheduledTime ?? '--:--'} - ${point.address.label}`,
            `   ${routeAddressText(point.address)}`,
            `   Passageiros (${passengers.length}): ${passengers.map((item) => item.passengerName ?? item.passengerId).join(', ')}`,
            ...(point.alerts.length > 0
              ? [`   Alertas: ${point.alerts.join(' | ')}`]
              : []),
          ];
        }),
      `Destino: ${snapshot.route.destination.label} - ${routeAddressText(snapshot.route.destination)}`,
      '',
      ...(snapshot.navigationLinks ?? []).map(
        (link) => `${link.label}: ${link.url}`,
      ),
    ];
    return basicPdf(
      `Rota operacional aprovada - ${snapshot.route.code}`,
      lines,
    );
  }
}
