import { Image } from "expo-image";
import { PixelRatio, View, type StyleProp, type ViewStyle } from "react-native";
import { useWorkspaceThumbnail } from "@/hooks/use-workspace-thumbnail";

/** List-only preview. Never decode the original at its full resolution. */
export function WorkspaceThumbnail({
  uri,
  size,
  style,
}: {
  uri: string;
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  // Remount the loader when a recycled row receives another file. This
  // drops its old native reference instead of displaying the previous file.
  return <ThumbnailImage key={uri} uri={uri} size={size} style={style} />;
}

function ThumbnailImage({ uri, size, style }: {
  uri: string;
  size: number;
  style?: StyleProp<ViewStyle>;
}) {
  const pixels = Math.min(512, Math.ceil(size * PixelRatio.get()));
  const image = useWorkspaceThumbnail(uri, pixels);
  if (!image) return <View style={style} />;
  return (
    <View style={style}>
      <Image
        source={image}
        contentFit="cover"
        autoplay={false}
        recyclingKey={uri}
        style={{ width: "100%", height: "100%" }}
      />
    </View>
  );
}
